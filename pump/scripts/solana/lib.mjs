/**
 * Shared helpers for the Solana operator scripts (config creation, devnet rehearsal).
 * Plain ESM, no build step: `node pump/scripts/solana/<script>.mjs`.
 */
import fs from "node:fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const LAMPORTS = 1_000_000_000;

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function clusterUrl(cluster) {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  return cluster === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
}

export function explorer(cluster, kind, id) {
  const suffix = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://solscan.io/${kind}/${id}${suffix}`;
}

/** Load a keypair from a JSON array file, a base58 string, or an env var; generate when absent. */
export function loadKeypair(source) {
  if (!source) return null;
  if (fs.existsSync(source)) {
    const raw = JSON.parse(fs.readFileSync(source, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(Array.isArray(raw) ? raw : raw.secretKey));
  }
  return Keypair.fromSecretKey(bs58.decode(source.trim()));
}

export function saveKeypair(file, kp) {
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
}

export async function solUsd() {
  if (process.env.SOL_USD) return Number(process.env.SOL_USD);
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    const v = Number(json?.solana?.usd);
    if (v > 0) return v;
  } catch (e) {
    log(`coingecko failed (${e.message}); using fallback`);
  }
  return Number(process.env.SOL_USD_FALLBACK || 150);
}

/**
 * Noxia's partner config: 2.7% flat fee, 10% of it to the creator, curve from $5k to $69k
 * market cap (in SOL at today's price), migration to DAMM v2 with LP permanently locked
 * 50/50 between partner and creator (they keep earning the pool fees; nobody can pull it).
 */
export function noxiaCurve(solPrice, { launchMcapUsd = 5000, graduationMcapUsd = 69_000 } = {}) {
  return buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 270, endingFeeBps: 270, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 10,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Slot,
    initialMarketCap: launchMcapUsd / solPrice,
    migrationMarketCap: graduationMcapUsd / solPrice,
  });
}

export async function sendTx(connection, tx, signers, label) {
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed", maxRetries: 5 });
  log(`${label}: ${sig}`);
  return sig;
}

export async function airdrop(connection, pubkey, sol) {
  for (let i = 0; i < 6; i++) {
    try {
      const sig = await connection.requestAirdrop(pubkey, Math.round(sol * LAMPORTS));
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      return sig;
    } catch (e) {
      log(`airdrop attempt ${i + 1} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    }
  }
  throw new Error("airdrop failed — fund the wallet manually (https://faucet.solana.com)");
}

export function connectionFor(cluster) {
  const url = clusterUrl(cluster);
  return new Connection(url, { commitment: "confirmed", confirmTransactionInitialTimeout: 90_000 });
}
