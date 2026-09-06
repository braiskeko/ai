/**
 * Pool of pre-mined "…noxia" mint keypairs.
 *
 * A grinder (running anywhere) uploads keypairs to `POST /api/admin/vanity`;
 * they are stored one per file in `VANITY_DIR` as `{publicKey, secretKey}` with
 * the secret key base58-encoded. When somebody launches a coin we *reserve* one:
 * the file moves to `VANITY_DIR/used/` and the keypair is held in memory for 15
 * minutes. Signing the creation transaction consumes it; abandoning the flow
 * releases it back into the pool.
 *
 * These keys are throwaway: a mint keypair only ever signs the single
 * `initialize_pool` instruction (the user's wallet pays and signs too) and the
 * mint authority is burned by the program right after. Nothing of value is
 * held here — but the files are still written with mode 0600.
 */
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { CA_SUFFIX, SOLANA_ADDRESS_RE } from "@shared/schema";
import { config } from "./config";
import { log } from "./vite";

/** How long a reserved mint is held before it returns to the pool. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface Reservation {
  /** opaque id handed to the client as PreparedCoin.id */
  id: string;
  keypair: Keypair;
  /** false when the pool was empty and we generated a throwaway mint */
  vanity: boolean;
  expiresAt: number;
}

export interface VanityKeypair {
  publicKey: string;
  secretKey: string;
}

const ROOT = path.resolve(config.vanityDir);
const USED_DIR = path.join(ROOT, "used");

/** base58 public key -> file name in ROOT, for every unreserved keypair. */
const available = new Map<string, string>();
/** reservation id -> reservation */
const reservations = new Map<string, Reservation>();
let usedTotal = 0;
let ready = false;

function fileNameFor(publicKey: string): string {
  return `${publicKey}.json`;
}

/** True when `address` is a base58 Solana address ending in the Noxia suffix. */
export function isVanityAddress(address: string): boolean {
  return SOLANA_ADDRESS_RE.test(address) && address.endsWith(CA_SUFFIX);
}

/**
 * Checks that `secretKey` really derives `publicKey` (a mismatched pair would
 * make pool creation fail with a signature error long after the upload).
 */
export function verifyKeypair(entry: VanityKeypair): Keypair | null {
  try {
    const secret = bs58.decode(entry.secretKey);
    if (secret.length !== nacl.sign.secretKeyLength) return null;
    const derived = nacl.sign.keyPair.fromSecretKey(secret);
    if (bs58.encode(derived.publicKey) !== entry.publicKey) return null;
    return Keypair.fromSecretKey(secret);
  } catch {
    return null;
  }
}

/** Reads the pool directory into memory. Safe to call more than once. */
export async function init(): Promise<void> {
  available.clear();
  await fs.mkdir(USED_DIR, { recursive: true });
  const entries = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const publicKey = entry.name.slice(0, -".json".length);
    if (!isVanityAddress(publicKey)) {
      log(`ignoring ${entry.name}: not a ${CA_SUFFIX} address`, "vanity");
      continue;
    }
    available.set(publicKey, entry.name);
  }
  usedTotal = (await fs.readdir(USED_DIR).catch(() => [])).filter((f) => f.endsWith(".json")).length;
  ready = true;
  log(`${available.size} vanity mints available, ${usedTotal} used (${ROOT})`, "vanity");
}

/** Number of pre-mined mints ready to be handed out. */
export function count(): number {
  return available.size;
}

/** Number of mints already consumed (or reserved and moved out of the pool). */
export function usedCount(): number {
  return usedTotal;
}

export function isReady(): boolean {
  return ready;
}

async function readKeypairFile(file: string): Promise<Keypair | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as VanityKeypair;
    return verifyKeypair(parsed);
  } catch {
    return null;
  }
}

/**
 * Takes a mint out of the pool for the next 15 minutes. Falls back to a freshly
 * generated (non-vanity) keypair when the pool is empty, so launching never
 * depends on the grinder keeping up.
 */
export async function reserve(): Promise<Reservation> {
  sweep();
  for (const [publicKey, name] of Array.from(available.entries())) {
    available.delete(publicKey);
    const source = path.join(ROOT, name);
    const keypair = await readKeypairFile(source);
    if (!keypair) {
      log(`dropping unusable vanity file ${name}`, "vanity");
      await fs.unlink(source).catch(() => {});
      continue;
    }
    await fs.rename(source, path.join(USED_DIR, name)).catch(() => {});
    usedTotal += 1;
    return track(keypair, true);
  }
  return track(Keypair.generate(), false);
}

function track(keypair: Keypair, vanity: boolean): Reservation {
  const reservation: Reservation = {
    id: randomUUID(),
    keypair,
    vanity,
    expiresAt: Date.now() + RESERVATION_TTL_MS,
  };
  reservations.set(reservation.id, reservation);
  return reservation;
}

/** The reservation for `id`, or undefined when unknown or expired. */
export function get(id: string): Reservation | undefined {
  sweep();
  return reservations.get(id);
}

/** Marks a reservation as spent (the creation transaction was built and sent). */
export function consume(id: string): void {
  reservations.delete(id);
}

/** Returns an unused vanity mint to the pool (called when a reservation expires). */
export async function release(id: string): Promise<void> {
  const reservation = reservations.get(id);
  if (!reservation) return;
  reservations.delete(id);
  if (!reservation.vanity) return;
  const publicKey = reservation.keypair.publicKey.toBase58();
  const name = fileNameFor(publicKey);
  try {
    await fs.rename(path.join(USED_DIR, name), path.join(ROOT, name));
    available.set(publicKey, name);
    usedTotal = Math.max(0, usedTotal - 1);
  } catch {
    // The file is gone (manually cleaned up): nothing to put back.
  }
}

/** Drops expired reservations and puts their vanity mints back into the pool. */
export function sweep(now = Date.now()): void {
  for (const [id, reservation] of Array.from(reservations.entries())) {
    if (reservation.expiresAt > now) continue;
    void release(id);
  }
}

/**
 * Stores uploaded keypairs, skipping malformed pairs, addresses that do not end
 * in the suffix and duplicates. Returns how many were added and the new pool size.
 */
export async function add(keypairs: VanityKeypair[]): Promise<{ added: number; available: number; rejected: number }> {
  await fs.mkdir(USED_DIR, { recursive: true });
  let added = 0;
  let rejected = 0;
  for (const entry of keypairs) {
    if (!isVanityAddress(entry.publicKey) || !verifyKeypair(entry)) {
      rejected += 1;
      continue;
    }
    const name = fileNameFor(entry.publicKey);
    if (available.has(entry.publicKey)) continue;
    const target = path.join(ROOT, name);
    // Already used at some point: never hand the same mint out twice.
    const usedBefore = await fs
      .stat(path.join(USED_DIR, name))
      .then(() => true)
      .catch(() => false);
    if (usedBefore) continue;
    await fs.writeFile(target, JSON.stringify({ publicKey: entry.publicKey, secretKey: entry.secretKey }), { mode: 0o600 });
    available.set(entry.publicKey, name);
    added += 1;
  }
  if (added) log(`stored ${added} vanity mints (${available.size} available)`, "vanity");
  return { added, available: available.size, rejected };
}

/** Test seam: forget everything loaded from disk. */
export function resetForTests(): void {
  available.clear();
  reservations.clear();
  usedTotal = 0;
  ready = false;
}
