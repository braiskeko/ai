import { randomBytes } from "crypto";
import {
  Contract,
  HDNodeWallet,
  Interface,
  JsonRpcProvider,
  Mnemonic,
  Wallet,
  formatUnits,
  getAddress,
  id as keccakId,
  parseUnits,
  zeroPadValue,
  type ContractTransactionResponse,
  type Log,
  type TopicFilter,
} from "ethers";
import type { Deposit, Withdrawal } from "@shared/schema";
import { storage, HttpError } from "./storage";
import { config } from "./config";
import { log } from "./vite";

/**
 * On-chain integration (ethers v6).
 *
 *  Deposits   Every user gets a unique address derived from one BIP-39 phrase
 *             (m/44'/60'/0'/0/<depositIndex>). A poller scans USDC Transfer
 *             logs to those addresses and credits the off-chain ledger once a
 *             transfer is `confirmations` blocks deep.
 *  Withdrawals A treasury hot wallet (TREASURY_PRIVATE_KEY) sends USDC to the
 *             user's address. Without a treasury key withdrawals stay
 *             "pending" for manual processing.
 *
 * All amounts crossing this module are plain numbers in USDC (6 decimals).
 */

// ---------------------------------------------------------------------------
// ERC-20 ABI
// ---------------------------------------------------------------------------

export const USDC_DECIMALS = 6;

export const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
] as const;

/** Shared ABI coder for USDC (any ERC-20). */
export const erc20Interface = new Interface([...ERC20_ABI]);

/** keccak256("Transfer(address,address,uint256)") - topic[0] of every ERC-20 transfer. */
export const TRANSFER_TOPIC = keccakId("Transfer(address,address,uint256)");

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let provider: JsonRpcProvider | null = null;

/**
 * Lazily created singleton provider. `staticNetwork` avoids an eth_chainId
 * round-trip per request and makes start-up work even when the RPC is
 * temporarily unreachable.
 */
export function getProvider(): JsonRpcProvider {
  provider ??= new JsonRpcProvider(config.chain.rpcUrl, config.chain.chainId, { staticNetwork: true });
  return provider;
}

// ---------------------------------------------------------------------------
// Deposit addresses (HD wallet)
// ---------------------------------------------------------------------------

/** BIP-44 account path; the deposit index is appended as the address index. */
export const DEPOSIT_DERIVATION_BASE = "m/44'/60'/0'/0";

let cachedMnemonic: string | null = null;
/** Node at DEPOSIT_DERIVATION_BASE, so per-address derivation skips the PBKDF2 seed step. */
let depositBranch: HDNodeWallet | null = null;

/**
 * The BIP-39 phrase that controls every deposit address.
 *
 * Priority: DEPOSIT_MNEMONIC env var, then the phrase persisted in the state
 * snapshot, generating one on first use. A generated phrase is logged once
 * with a loud warning: whoever runs the deployment must back it up, otherwise
 * funds sent to deposit addresses are lost if the state snapshot is lost.
 */
export function getMnemonic(): string {
  if (cachedMnemonic) return cachedMnemonic;

  if (config.depositMnemonic) {
    if (!Mnemonic.isValidMnemonic(config.depositMnemonic)) {
      throw new Error("DEPOSIT_MNEMONIC is not a valid BIP-39 mnemonic phrase");
    }
    cachedMnemonic = config.depositMnemonic;
    return cachedMnemonic;
  }

  let generated = false;
  const phrase = storage.getOrCreateMnemonic(() => {
    generated = true;
    // 16 bytes of entropy -> 12 word phrase (same strength as HDNodeWallet.createRandom()).
    return Mnemonic.entropyToPhrase(randomBytes(16));
  });
  if (!Mnemonic.isValidMnemonic(phrase)) {
    throw new Error("The deposit mnemonic stored in the application state is not a valid BIP-39 phrase");
  }

  if (generated) {
    log("WARNING: no DEPOSIT_MNEMONIC configured - a new deposit wallet mnemonic was generated.", "chain");
    log(`WARNING: this phrase controls all funds sent to user deposit addresses: "${phrase}"`, "chain");
    log(
      "WARNING: back it up now and set DEPOSIT_MNEMONIC to it so deposit addresses stay stable across data resets.",
      "chain",
    );
  } else {
    log(
      "deposit mnemonic loaded from the state snapshot (set DEPOSIT_MNEMONIC to make it independent of the data store)",
      "chain",
    );
  }

  cachedMnemonic = phrase;
  return phrase;
}

function getDepositBranch(): HDNodeWallet {
  if (!depositBranch) {
    depositBranch = HDNodeWallet.fromPhrase(getMnemonic(), undefined, DEPOSIT_DERIVATION_BASE);
  }
  return depositBranch;
}

/** Checksummed deposit address for a user's `depositIndex`. Deterministic per mnemonic. */
export function deriveDepositAddress(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error(`Invalid deposit index ${index}`);
  }
  // Equivalent to HDNodeWallet.fromPhrase(mnemonic, undefined, `${DEPOSIT_DERIVATION_BASE}/${index}`).address
  // but reuses the cached branch node instead of re-deriving the seed each time.
  return getDepositBranch().deriveChild(index).address;
}

// ---------------------------------------------------------------------------
// Treasury (withdrawals)
// ---------------------------------------------------------------------------

let treasuryWallet: Wallet | null | undefined;

/** The hot wallet paying withdrawals, or null when unset / malformed. */
function loadTreasuryWallet(): Wallet | null {
  if (treasuryWallet !== undefined) return treasuryWallet;
  if (!config.treasuryPrivateKey) {
    treasuryWallet = null;
    return treasuryWallet;
  }
  try {
    treasuryWallet = new Wallet(config.treasuryPrivateKey);
  } catch (err) {
    log(`TREASURY_PRIVATE_KEY is not a valid private key: ${errorMessage(err)} - withdrawals disabled`, "chain");
    treasuryWallet = null;
  }
  return treasuryWallet;
}

/** Address of the treasury hot wallet, or null when withdrawals are manual. */
export function getTreasuryAddress(): string | null {
  return loadTreasuryWallet()?.address ?? null;
}

/**
 * True when TREASURY_PRIVATE_KEY is configured (and parses), i.e. withdrawals
 * are paid automatically. Otherwise they remain "pending" for an admin.
 */
export const withdrawalsEnabled: boolean = loadTreasuryWallet() !== null;

// ---------------------------------------------------------------------------
// Deposit watcher
// ---------------------------------------------------------------------------

/** How often we poll for new confirmed blocks. */
const POLL_INTERVAL_MS = 20_000;
/** Public RPCs reject eth_getLogs over large ranges; 1000 blocks is widely accepted. */
const MAX_BLOCK_RANGE = 1000;
/** Blocks to look back on the very first run (no lastScannedBlock yet). */
const INITIAL_LOOKBACK_BLOCKS = 500;

/** Human readable, bounded error text (ethers errors embed whole JSON payloads). */
function errorMessage(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown } | null;
  const raw =
    typeof e?.shortMessage === "string" && e.shortMessage
      ? e.shortMessage
      : typeof e?.message === "string" && e.message
        ? e.message
        : String(err);
  return raw.length > 300 ? `${raw.slice(0, 297)}...` : raw;
}

/**
 * Credit a single Transfer log if it targets a known deposit address.
 * Returns true when a new deposit was recorded.
 */
function handleTransferLog(
  entry: Log,
  userByAddress: Map<string, number>,
  onDeposit: (userId: number, deposit: Deposit) => void,
): boolean {
  // Logs flagged `removed` belong to a reorged-out block; we only scan finalized
  // depth so this should never happen, but never credit them.
  if (entry.removed) return false;

  const parsed = erc20Interface.parseLog({ topics: [...entry.topics], data: entry.data });
  if (!parsed || parsed.name !== "Transfer") return false;

  const to = String(parsed.args.to).toLowerCase();
  const userId = userByAddress.get(to);
  if (userId === undefined) return false;

  const value = parsed.args.value as bigint;
  const amount = Number(formatUnits(value, USDC_DECIMALS));
  if (!Number.isFinite(amount) || amount <= 0) return false;

  // One ERC-20 transaction can contain several transfers, so the idempotency
  // key includes the log index.
  const key = `${entry.transactionHash}:${entry.index}`;
  const deposit = storage.recordDeposit(userId, key, amount, entry.blockNumber);
  if (!deposit) return false; // already credited

  log(`deposit of ${amount} USDC credited to user #${userId} (tx ${entry.transactionHash}, block ${entry.blockNumber})`, "chain");
  try {
    onDeposit(userId, deposit);
  } catch (err) {
    log(`onDeposit handler failed for deposit #${deposit.id}: ${errorMessage(err)}`, "chain");
  }
  return true;
}

/**
 * One scan pass: fetch Transfer logs to every deposit address between the last
 * scanned block and the newest block with enough confirmations, in chunks.
 * `lastScannedBlock` only advances past chunks that were processed fully, so a
 * failed RPC call is retried on the next pass without skipping blocks.
 */
async function scanDeposits(
  rpc: JsonRpcProvider,
  onDeposit: (userId: number, deposit: Deposit) => void,
  isStopped: () => boolean,
): Promise<void> {
  const latest = await rpc.getBlockNumber();
  const target = latest - config.chain.confirmations;
  if (target < 0) return;

  const last = storage.getLastScannedBlock();
  const from = Math.max(0, (last ?? target - INITIAL_LOOKBACK_BLOCKS) + 1);
  if (from > target) return;

  // Snapshot the address list for this pass. A user created while the pass runs
  // cannot have a deposit inside [from, target]: those blocks were mined before
  // the pass started, i.e. before the address was ever shown to anyone.
  const addresses = storage.listDepositAddresses();
  if (addresses.length === 0) {
    storage.setLastScannedBlock(target);
    return;
  }

  const userByAddress = new Map<string, number>();
  const paddedAddresses: string[] = [];
  for (const { address, userId } of addresses) {
    try {
      const checksummed = getAddress(address);
      userByAddress.set(checksummed.toLowerCase(), userId);
      paddedAddresses.push(zeroPadValue(checksummed, 32));
    } catch {
      log(`skipping malformed deposit address "${address}" for user #${userId}`, "chain");
    }
  }
  if (paddedAddresses.length === 0) {
    storage.setLastScannedBlock(target);
    return;
  }

  // topics[2] as an array is an OR filter over recipients (indexed `to`).
  const topics: TopicFilter = [TRANSFER_TOPIC, null, paddedAddresses];

  for (let start = from; start <= target; start += MAX_BLOCK_RANGE) {
    if (isStopped()) return;
    const end = Math.min(start + MAX_BLOCK_RANGE - 1, target);

    let logs: Log[];
    try {
      logs = await rpc.getLogs({
        address: config.chain.usdcAddress,
        fromBlock: start,
        toBlock: end,
        topics,
      });
    } catch (err) {
      log(`eth_getLogs ${start}-${end} failed: ${errorMessage(err)} (will retry next poll)`, "chain");
      return; // do not advance past the failed chunk
    }

    let credited = 0;
    for (const entry of logs) {
      if (handleTransferLog(entry, userByAddress, onDeposit)) credited += 1;
    }
    if (credited > 0) log(`blocks ${start}-${end}: ${credited} new deposit(s)`, "chain");

    storage.setLastScannedBlock(end);
  }
}

/**
 * Start polling the chain for USDC deposits. Runs immediately, then every 20s,
 * never overlapping. RPC failures are logged and retried; they never crash the
 * process. Returns a function that stops the watcher.
 */
export function startDepositWatcher(onDeposit: (userId: number, deposit: Deposit) => void): () => void {
  if (!config.depositsEnabled) {
    log("deposit watcher disabled (DEPOSITS_ENABLED=0)", "chain");
    return () => {};
  }

  const rpc = getProvider();
  let running = false;
  let stopped = false;

  const runOnce = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await scanDeposits(rpc, onDeposit, () => stopped);
    } catch (err) {
      log(`deposit scan failed: ${errorMessage(err)} (will retry next poll)`, "chain");
    } finally {
      running = false;
    }
  };

  log(
    `deposit watcher started on ${config.chain.name} (chainId ${config.chain.chainId}, USDC ${config.chain.usdcAddress}, ${config.chain.confirmations} confirmations, every ${POLL_INTERVAL_MS / 1000}s)`,
    "chain",
  );
  void runOnce();
  const timer = setInterval(() => void runOnce(), POLL_INTERVAL_MS);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    log("deposit watcher stopped", "chain");
  };
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

/**
 * Send `amount` USDC from the treasury to `to`, wait for one confirmation and
 * return the transaction hash. Throws HttpError 503 when no treasury key is
 * configured, 400 for an invalid recipient or amount, and a plain Error when
 * the transaction fails or reverts.
 */
export async function sendWithdrawal(to: string, amount: number): Promise<string> {
  const signer = loadTreasuryWallet();
  if (!signer) throw new HttpError(503, "Withdrawals are not enabled on this deployment");

  let recipient: string;
  try {
    recipient = getAddress(to);
  } catch {
    throw new HttpError(400, "Invalid withdrawal address");
  }
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "Invalid withdrawal amount");

  // toFixed(6) guards against float noise such as 12.3400000001 which parseUnits rejects.
  const value = parseUnits(amount.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  if (value <= BigInt(0)) throw new HttpError(400, "Withdrawal amount is below 0.000001 USDC");

  const wallet = signer.connect(getProvider());
  const usdc = new Contract(config.chain.usdcAddress, erc20Interface, wallet);

  // Fail fast with an actionable message instead of a reverted transaction.
  const treasuryBalance = (await usdc.balanceOf(wallet.address)) as bigint;
  if (treasuryBalance < value) {
    throw new Error(
      `Treasury ${wallet.address} holds ${formatUnits(treasuryBalance, USDC_DECIMALS)} USDC, less than the ${amount} USDC requested`,
    );
  }

  const tx = (await usdc.transfer(recipient, value)) as ContractTransactionResponse;
  log(`withdrawal tx ${tx.hash}: ${amount} USDC -> ${recipient}`, "chain");

  const receipt = await tx.wait(1);
  if (!receipt) throw new Error(`Transaction ${tx.hash} was dropped before confirmation`);
  if (receipt.status !== 1) throw new Error(`Transaction ${tx.hash} reverted on-chain`);

  log(`withdrawal tx ${tx.hash} confirmed in block ${receipt.blockNumber}`, "chain");
  return tx.hash;
}

/** Withdrawals currently being broadcast, to prevent double payment on concurrent calls. */
const inFlightWithdrawals = new Set<number>();

/**
 * Pay a pending withdrawal from the treasury and record the outcome.
 *
 *  - No treasury key: returned unchanged (stays "pending" for manual payout).
 *  - Success: status "sent" with the tx hash.
 *  - Failure: status "failed" with the error; storage refunds the user.
 */
export async function processWithdrawal(id: number): Promise<Withdrawal> {
  const withdrawal = storage.getWithdrawal(id);
  if (!withdrawal) throw new HttpError(404, "Withdrawal not found");
  if (withdrawal.status !== "pending") return withdrawal;

  if (!withdrawalsEnabled) {
    log(`withdrawal #${id} (${withdrawal.amount} USDC -> ${withdrawal.toAddress}) left pending: no treasury key`, "chain");
    return withdrawal;
  }

  if (inFlightWithdrawals.has(id)) return withdrawal;
  inFlightWithdrawals.add(id);
  try {
    const txHash = await sendWithdrawal(withdrawal.toAddress, withdrawal.amount);
    return storage.updateWithdrawal(id, { status: "sent", txHash, error: null });
  } catch (err) {
    const message = errorMessage(err);
    log(`withdrawal #${id} failed: ${message}`, "chain");
    return storage.updateWithdrawal(id, { status: "failed", error: message });
  } finally {
    inFlightWithdrawals.delete(id);
  }
}
