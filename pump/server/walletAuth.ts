import { randomBytes } from "crypto";
import { getAddress, isAddress, verifyMessage } from "ethers";
import { config } from "./config";
import { HttpError } from "./storage";

/**
 * Sign-In-With-Ethereum style wallet login.
 *
 *  1. GET /api/auth/wallet/nonce?address=0x…  → we issue a random nonce bound to
 *     the address and return the exact message the wallet must sign.
 *  2. The browser calls `personal_sign` on that message.
 *  3. POST /api/auth/wallet {address, signature, nonce} → we rebuild the message
 *     from our stored copy of the nonce (never from client input), recover the
 *     signer with ethers and require it to equal the address.
 *
 * Nonces live in memory for 10 minutes and are single-use, so a captured
 * signature cannot be replayed. A restart simply invalidates outstanding
 * challenges; the client just asks for a new one.
 */

const NONCE_TTL_MS = 10 * 60 * 1000;
/** Hard ceiling on outstanding challenges so a flood of nonce requests cannot exhaust memory. */
const MAX_PENDING_NONCES = 50_000;

interface NonceRecord {
  /** checksummed address the nonce was issued for */
  address: string;
  issuedAt: number;
}

const nonces = new Map<string, NonceRecord>();

function purgeExpired(now: number): void {
  nonces.forEach((record, nonce) => {
    if (now - record.issuedAt >= NONCE_TTL_MS) nonces.delete(nonce);
  });
  // Map iterates in insertion order, so the first entries are the oldest.
  if (nonces.size > MAX_PENDING_NONCES) {
    const excess = nonces.size - MAX_PENDING_NONCES;
    Array.from(nonces.keys())
      .slice(0, excess)
      .forEach((nonce) => nonces.delete(nonce));
  }
}

const sweep = setInterval(() => purgeExpired(Date.now()), NONCE_TTL_MS);
sweep.unref();

/** The human-readable challenge shown by the wallet. Rebuilt server-side on verification. */
export function buildWalletMessage(address: string, nonce: string, issuedAt: number): string {
  return `Sign in to ${config.appName}\n\nAddress: ${address}\nNonce: ${nonce}\nIssued: ${new Date(issuedAt).toISOString()}`;
}

/** Checksummed form of an EVM address, or HttpError 400. */
export function normalizeAddress(raw: unknown): string {
  if (typeof raw !== "string" || !isAddress(raw)) throw new HttpError(400, "Invalid wallet address");
  return getAddress(raw);
}

/** Issue a fresh single-use nonce for `rawAddress` and return it with the message to sign. */
export function issueWalletNonce(rawAddress: unknown): { nonce: string; message: string } {
  const address = normalizeAddress(rawAddress);
  const now = Date.now();
  purgeExpired(now);
  const nonce = randomBytes(16).toString("hex");
  nonces.set(nonce, { address, issuedAt: now });
  return { nonce, message: buildWalletMessage(address, nonce, now) };
}

/**
 * Verify a signed challenge. Consumes the nonce whether or not verification
 * succeeds (one attempt per challenge). Returns the checksummed address on
 * success; throws HttpError 401 otherwise.
 */
export function verifyWalletLogin(input: { address: string; signature: string; nonce: string }): string {
  const now = Date.now();
  purgeExpired(now);

  const record = nonces.get(input.nonce);
  if (record) nonces.delete(input.nonce);
  if (!record || now - record.issuedAt >= NONCE_TTL_MS) {
    throw new HttpError(401, "Your sign-in request expired. Please try again.");
  }

  let address: string;
  try {
    address = getAddress(input.address);
  } catch {
    throw new HttpError(401, "Invalid wallet address");
  }
  if (address !== record.address) {
    throw new HttpError(401, "This sign-in request was issued for a different wallet.");
  }

  const message = buildWalletMessage(record.address, input.nonce, record.issuedAt);
  let recovered: string;
  try {
    recovered = verifyMessage(message, input.signature);
  } catch {
    throw new HttpError(401, "Invalid wallet signature");
  }
  if (getAddress(recovered) !== address) {
    throw new HttpError(401, "The signature does not match this wallet.");
  }
  return address;
}

/** Number of unexpired challenges (for tests / diagnostics). */
export function pendingWalletNonces(): number {
  purgeExpired(Date.now());
  return nonces.size;
}
