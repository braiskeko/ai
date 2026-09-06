import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SOLANA_ADDRESS_RE } from "@shared/schema";
import { config } from "./config";
import { HttpError } from "./storage";

/**
 * Sign-In-With-Solana style wallet login.
 *
 *  1. GET /api/auth/wallet/nonce?address=…  → we issue a random nonce bound to
 *     the address and return the exact message the wallet must sign.
 *  2. The browser calls `signMessage(new TextEncoder().encode(message))`.
 *  3. POST /api/auth/wallet {address, signature, nonce} → we rebuild the message
 *     from our stored copy of the nonce (never from client input) and verify the
 *     detached ed25519 signature against the address, which *is* the public key.
 *
 * The nonce carries its own proof: it is `<issuedAt>.<random>.<hmac>`, signed
 * with the server secret, so any process can verify a challenge another one
 * issued. This matters because the app runs several workers — a nonce kept only
 * in the memory of the worker that issued it is unknown to whichever worker
 * receives the signature, which made linking fail at random. Challenges last ten
 * minutes, and each one is remembered until it expires so it cannot be used
 * twice on the worker that saw it.
 *
 * The same challenge is used by POST /api/me/wallet to link a wallet to an
 * existing email / Google / Apple account.
 */

const NONCE_TTL_MS = 10 * 60 * 1000;
/** Hard ceiling on outstanding challenges so a flood of nonce requests cannot exhaust memory. */
const MAX_PENDING_NONCES = 50_000;

/** Nonces already used on this worker, so a challenge is not replayed here. */
const spent = new Map<string, number>();

function purgeExpired(now: number): void {
  spent.forEach((issuedAt, nonce) => {
    if (now - issuedAt >= NONCE_TTL_MS) spent.delete(nonce);
  });
  // Map iterates in insertion order, so the first entries are the oldest.
  if (spent.size > MAX_PENDING_NONCES) {
    const excess = spent.size - MAX_PENDING_NONCES;
    Array.from(spent.keys())
      .slice(0, excess)
      .forEach((nonce) => spent.delete(nonce));
  }
}

/** The proof carried inside a nonce: this server issued it, for this address. */
function sealNonce(address: string, issuedAt: number, random: string): string {
  return createHmac("sha256", config.sessionSecret)
    .update(`${address}|${issuedAt}|${random}`)
    .digest("hex")
    .slice(0, 32);
}

function openNonce(nonce: string, address: string, now: number): number | null {
  const [issuedRaw, random, mac] = nonce.split(".");
  if (!issuedRaw || !random || !mac) return null;
  const issuedAt = Number.parseInt(issuedRaw, 36);
  if (!Number.isFinite(issuedAt) || now - issuedAt >= NONCE_TTL_MS || issuedAt - now > 60_000) return null;
  const expected = sealNonce(address, issuedAt, random);
  if (expected.length !== mac.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  return issuedAt;
}

const sweep = setInterval(() => purgeExpired(Date.now()), NONCE_TTL_MS);
sweep.unref();

/** The human-readable challenge shown by the wallet. Rebuilt server-side on verification. */
export function buildWalletMessage(address: string, nonce: string, issuedAt: number): string {
  return (
    `${config.appName} wants you to sign in with your Solana account:\n${address}\n\n` +
    `Nonce: ${nonce}\nIssued At: ${new Date(issuedAt).toISOString()}`
  );
}

/** A valid base58 Solana address, or HttpError 400. Solana addresses are case sensitive. */
export function normalizeAddress(raw: unknown): string {
  if (typeof raw !== "string") throw new HttpError(400, "Invalid wallet address");
  const address = raw.trim();
  if (!SOLANA_ADDRESS_RE.test(address)) throw new HttpError(400, "Invalid wallet address");
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(address);
  } catch {
    throw new HttpError(400, "Invalid wallet address");
  }
  if (decoded.length !== nacl.sign.publicKeyLength) throw new HttpError(400, "Invalid wallet address");
  return address;
}

/** Issue a fresh single-use nonce for `rawAddress` and return it with the message to sign. */
export function issueWalletNonce(rawAddress: unknown): { nonce: string; message: string } {
  const address = normalizeAddress(rawAddress);
  const now = Date.now();
  purgeExpired(now);
  const random = randomBytes(12).toString("hex");
  const nonce = `${now.toString(36)}.${random}.${sealNonce(address, now, random)}`;
  return { nonce, message: buildWalletMessage(address, nonce, now) };
}

/**
 * Verify a signed challenge. Consumes the nonce whether or not verification
 * succeeds (one attempt per challenge). Returns the address on success; throws
 * HttpError 401 otherwise.
 */
export function verifyWalletLogin(input: { address: string; signature: string; nonce: string }): string {
  const now = Date.now();
  purgeExpired(now);

  let address: string;
  try {
    address = normalizeAddress(input.address);
  } catch {
    throw new HttpError(401, "Invalid wallet address");
  }

  if (spent.has(input.nonce)) throw new HttpError(401, "That sign-in request was already used. Please try again.");
  // A nonce is bound to its address, so a challenge cannot be replayed for another.
  const issuedAt = openNonce(input.nonce, address, now);
  if (issuedAt === null) throw new HttpError(401, "Your sign-in request expired. Please try again.");
  spent.set(input.nonce, issuedAt);

  const message = buildWalletMessage(address, input.nonce, issuedAt);
  let valid = false;
  try {
    const signature = bs58.decode(input.signature);
    if (signature.length !== nacl.sign.signatureLength) throw new Error("bad signature length");
    valid = nacl.sign.detached.verify(new TextEncoder().encode(message), signature, bs58.decode(address));
  } catch {
    throw new HttpError(401, "Invalid wallet signature");
  }
  if (!valid) throw new HttpError(401, "The signature does not match this wallet.");
  return address;
}

/** Number of challenges spent recently (for tests / diagnostics). */
export function pendingWalletNonces(): number {
  purgeExpired(Date.now());
  return spent.size;
}
