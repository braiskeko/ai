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
 * program takes the mint authority from there. Nothing of value is held here —
 * but the files are still written with mode 0600.
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

/**
 * Checks that `secretKey` really derives `publicKey` — a mismatched pair would
 * only fail much later, as a signature error during pool creation.
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

/**
 * A directory of pre-mined mints plus the in-memory reservations over it.
 * `suffix` is what a stored address must end in ("" accepts any address, which
 * only the tests use).
 */
export class VanityPool {
  private readonly usedDir: string;
  /** base58 public key -> file name, for every unreserved keypair */
  private readonly available = new Map<string, string>();
  private readonly reservations = new Map<string, Reservation>();
  private used = 0;
  private loaded = false;

  constructor(
    private readonly dir: string,
    private readonly suffix: string = CA_SUFFIX,
  ) {
    this.usedDir = path.join(dir, "used");
  }

  /** True when `address` is a base58 Solana address carrying the pool's suffix. */
  accepts(address: string): boolean {
    return SOLANA_ADDRESS_RE.test(address) && address.endsWith(this.suffix);
  }

  /** Reads the pool directory into memory. Safe to call more than once. */
  async init(): Promise<void> {
    this.available.clear();
    await fs.mkdir(this.usedDir, { recursive: true });
    const entries = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const publicKey = entry.name.slice(0, -".json".length);
      if (!this.accepts(publicKey)) {
        log(`ignoring ${entry.name}: not a ${this.suffix || "valid"} address`, "vanity");
        continue;
      }
      this.available.set(publicKey, entry.name);
    }
    this.used = (await fs.readdir(this.usedDir).catch(() => [])).filter((f) => f.endsWith(".json")).length;
    this.loaded = true;
    log(`${this.available.size} vanity mints available, ${this.used} used (${this.dir})`, "vanity");
  }

  get isReady(): boolean {
    return this.loaded;
  }

  /** Number of pre-mined mints ready to be handed out. */
  count(): number {
    return this.available.size;
  }

  /** Number of mints already consumed (or reserved and moved out of the pool). */
  usedCount(): number {
    return this.used;
  }

  /**
   * Takes a mint out of the pool for the next 15 minutes. Falls back to a freshly
   * generated (non-vanity) keypair when the pool is empty, so launching never
   * depends on the grinder keeping up.
   */
  async reserve(): Promise<Reservation> {
    this.sweep();
    for (const [publicKey, name] of Array.from(this.available.entries())) {
      this.available.delete(publicKey);
      const source = path.join(this.dir, name);
      const keypair = await this.readKeypairFile(source);
      if (!keypair) {
        log(`dropping unusable vanity file ${name}`, "vanity");
        await fs.unlink(source).catch(() => {});
        continue;
      }
      await fs.mkdir(this.usedDir, { recursive: true });
      await fs.rename(source, path.join(this.usedDir, name)).catch(() => {});
      this.used += 1;
      return this.track(keypair, true);
    }
    return this.track(Keypair.generate(), false);
  }

  /** The reservation for `id`, or undefined when unknown or expired. */
  get(id: string): Reservation | undefined {
    this.sweep();
    return this.reservations.get(id);
  }

  /** Marks a reservation as spent (its creation transaction was built). */
  consume(id: string): void {
    this.reservations.delete(id);
  }

  /** Returns an unused vanity mint to the pool. */
  async release(id: string): Promise<void> {
    const reservation = this.reservations.get(id);
    if (!reservation) return;
    this.reservations.delete(id);
    if (!reservation.vanity) return;
    const publicKey = reservation.keypair.publicKey.toBase58();
    const name = `${publicKey}.json`;
    try {
      await fs.rename(path.join(this.usedDir, name), path.join(this.dir, name));
      this.available.set(publicKey, name);
      this.used = Math.max(0, this.used - 1);
    } catch {
      // The file is gone (manually cleaned up): nothing to put back.
    }
  }

  /** Drops expired reservations and puts their vanity mints back into the pool. */
  sweep(now = Date.now()): void {
    for (const [id, reservation] of Array.from(this.reservations.entries())) {
      if (reservation.expiresAt > now) continue;
      void this.release(id);
    }
  }

  /**
   * Stores uploaded keypairs, skipping malformed pairs, addresses without the
   * suffix and mints that were already handed out.
   */
  async add(keypairs: VanityKeypair[]): Promise<{ added: number; available: number; rejected: number }> {
    await fs.mkdir(this.usedDir, { recursive: true });
    let added = 0;
    let rejected = 0;
    for (const entry of keypairs) {
      if (!this.accepts(entry.publicKey) || !verifyKeypair(entry)) {
        rejected += 1;
        continue;
      }
      const name = `${entry.publicKey}.json`;
      if (this.available.has(entry.publicKey)) continue;
      const usedBefore = await fs
        .stat(path.join(this.usedDir, name))
        .then(() => true)
        .catch(() => false);
      if (usedBefore) continue;
      await fs.writeFile(path.join(this.dir, name), JSON.stringify({ publicKey: entry.publicKey, secretKey: entry.secretKey }), {
        mode: 0o600,
      });
      this.available.set(entry.publicKey, name);
      added += 1;
    }
    if (added) log(`stored ${added} vanity mints (${this.available.size} available)`, "vanity");
    return { added, available: this.available.size, rejected };
  }

  private track(keypair: Keypair, vanity: boolean): Reservation {
    const reservation: Reservation = {
      id: randomUUID(),
      keypair,
      vanity,
      expiresAt: Date.now() + RESERVATION_TTL_MS,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  private async readKeypairFile(file: string): Promise<Keypair | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as VanityKeypair;
      return verifyKeypair(parsed);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// The pool the server uses (VANITY_DIR)
// ---------------------------------------------------------------------------

export const pool = new VanityPool(path.resolve(config.vanityDir));

export const init = (): Promise<void> => pool.init();
export const count = (): number => pool.count();
export const usedCount = (): number => pool.usedCount();
export const reserve = (): Promise<Reservation> => pool.reserve();
export const get = (id: string): Reservation | undefined => pool.get(id);
export const consume = (id: string): void => pool.consume(id);
export const release = (id: string): Promise<void> => pool.release(id);
export const sweep = (now?: number): void => pool.sweep(now);
export const add = (keypairs: VanityKeypair[]): Promise<{ added: number; available: number; rejected: number }> =>
  pool.add(keypairs);
export const isVanityAddress = (address: string): boolean => pool.accepts(address);
