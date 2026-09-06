/**
 * Create Noxia's Meteora DBC partner config (one-time per cluster).
 *
 *   CLUSTER=mainnet-beta PAYER=./payer.json TREASURY=<wallet> node pump/scripts/solana/create-config.mjs
 *
 *   CLUSTER    mainnet-beta | devnet (default devnet)
 *   PAYER      keypair file / base58 secret that pays the rent (~0.05 SOL); also the config owner
 *   TREASURY   wallet that claims 90% of the fees and receives leftovers (feeClaimer)
 *   RPC_URL    optional RPC override
 *   SOL_USD    optional price override (else CoinGecko)
 *
 * Prints the config address and writes pump/scripts/solana/config.<cluster>.json.
 */
import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT, connectionFor, explorer, loadKeypair, log, noxiaCurve, sendTx, solUsd } from "./lib.mjs";

const cluster = process.env.CLUSTER || "devnet";
const payer = loadKeypair(process.env.PAYER);
if (!payer) throw new Error("PAYER keypair required");
const treasury = new PublicKey(process.env.TREASURY || payer.publicKey.toBase58());

const connection = connectionFor(cluster);
const balance = await connection.getBalance(payer.publicKey);
log(`cluster ${cluster}, payer ${payer.publicKey.toBase58()} (${balance / 1e9} SOL), treasury ${treasury.toBase58()}`);
if (balance < 0.03e9) throw new Error("payer needs at least 0.03 SOL");

const price = await solUsd();
const curve = noxiaCurve(price);
log(`SOL/USD ${price} → migration threshold ${Number(curve.migrationQuoteThreshold.toString()) / 1e9} SOL`);

const dbc = DynamicBondingCurveClient.create(connection, "confirmed");
const configKeypair = Keypair.generate();
const tx = await dbc.partner.createConfig({
  config: configKeypair.publicKey,
  feeClaimer: treasury,
  leftoverReceiver: treasury,
  quoteMint: NATIVE_MINT,
  payer: payer.publicKey,
  ...curve,
});
const sig = await sendTx(connection, tx, [payer, configKeypair], "createConfig");

const out = {
  cluster,
  config: configKeypair.publicKey.toBase58(),
  treasury: treasury.toBase58(),
  payer: payer.publicKey.toBase58(),
  solUsdAtCreation: price,
  migrationQuoteThresholdSol: Number(curve.migrationQuoteThreshold.toString()) / 1e9,
  signature: sig,
  explorer: explorer(cluster, "account", configKeypair.publicKey.toBase58()),
  createdAt: new Date().toISOString(),
};
const file = path.join(path.dirname(new URL(import.meta.url).pathname), `config.${cluster}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
log(`DBC_CONFIG=${out.config}`);
log(`wrote ${file}`);
