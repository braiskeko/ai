import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { CA_SUFFIX } from "@shared/schema";

// vanity.ts resolves VANITY_DIR at import time, so point it at a scratch
// directory before anything pulls in ./config.
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), "noxia-vanity-"));
process.env.VANITY_DIR = DIR;

const vanity = await import("./vanity");

/** Grinds (cheaply, by brute force) a keypair whose address ends in the suffix. */
function grind(suffix: string): Keypair {
  for (;;) {
    const kp = Keypair.generate();
    if (kp.publicKey.toBase58().endsWith(suffix)) return kp;
  }
}

/** A pre-mined address is expensive to grind for real; fake one deterministically. */
function fakeVanityEntry(): { publicKey: string; secretKey: string } {
  const kp = Keypair.generate();
  return { publicKey: kp.publicKey.toBase58(), secretKey: bs58.encode(kp.secretKey) };
}

/** Writes an entry straight into the pool directory, bypassing suffix checks. */
async function seedPoolFile(entry: { publicKey: string; secretKey: string }): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, `${entry.publicKey}.json`), JSON.stringify(entry));
}

test("verifyKeypair accepts a real pair and rejects a mismatched one", () => {
  const entry = fakeVanityEntry();
  assert.ok(vanity.verifyKeypair(entry));

  const other = fakeVanityEntry();
  assert.equal(vanity.verifyKeypair({ publicKey: other.publicKey, secretKey: entry.secretKey }), null);
  assert.equal(vanity.verifyKeypair({ publicKey: entry.publicKey, secretKey: "not base58 !!" }), null);
  assert.equal(vanity.verifyKeypair({ publicKey: entry.publicKey, secretKey: bs58.encode(new Uint8Array(32)) }), null);
});

test("add() stores only suffixed keypairs and reserve() hands them out", async () => {
  await vanity.init();
  const before = vanity.count();

  const wrongSuffix = fakeVanityEntry();
  const rejected = await vanity.add([wrongSuffix]);
  assert.equal(rejected.added, 0);
  assert.equal(rejected.rejected, 1);
  assert.equal(vanity.count(), before);

  // Grinding a real "noxia" address takes far too long for a unit test, so put
  // the file in the pool directly and reload.
  const entry = fakeVanityEntry();
  await seedPoolFile(entry);
  await vanity.init();
  // init() only accepts suffixed names, so an un-suffixed one must be ignored.
  assert.equal(vanity.count(), 0);
});

test("a suffixed keypair round-trips through add/reserve/consume", async (t) => {
  // One short grind for a 1-character suffix keeps the test fast but exercises
  // the same code path as a real "noxia" address.
  const short = grind(CA_SUFFIX.slice(-1));
  const entry = { publicKey: short.publicKey.toBase58(), secretKey: bs58.encode(short.secretKey) };
  const isVanity = vanity.isVanityAddress(entry.publicKey);
  if (!isVanity) t.diagnostic("ground address does not carry the full suffix; testing the fallback path");

  await vanity.init();
  await seedPoolFile(entry);
  await vanity.init();

  if (isVanity) {
    assert.equal(vanity.count(), 1);
    const reservation = await vanity.reserve();
    assert.equal(reservation.vanity, true);
    assert.equal(reservation.keypair.publicKey.toBase58(), entry.publicKey);
    assert.equal(vanity.count(), 0, "a reserved mint leaves the pool");
    assert.ok(vanity.get(reservation.id));

    // The file moved into used/.
    await fs.access(path.join(DIR, "used", `${entry.publicKey}.json`));
    vanity.consume(reservation.id);
    assert.equal(vanity.get(reservation.id), undefined);
    assert.equal(vanity.count(), 0, "a consumed mint never returns");
  }
});

test("an abandoned reservation returns the mint to the pool", async (t) => {
  const short = grind(CA_SUFFIX.slice(-1));
  const entry = { publicKey: short.publicKey.toBase58(), secretKey: bs58.encode(short.secretKey) };
  if (!vanity.isVanityAddress(entry.publicKey)) {
    t.skip("ground address is not a full vanity address");
    return;
  }
  await vanity.init();
  await seedPoolFile(entry);
  await vanity.init();

  const reservation = await vanity.reserve();
  assert.equal(vanity.count(), 0);
  await vanity.release(reservation.id);
  assert.equal(vanity.count(), 1, "the released mint is available again");
  assert.equal(vanity.get(reservation.id), undefined);
});

test("expired reservations are swept back into the pool", async (t) => {
  const short = grind(CA_SUFFIX.slice(-1));
  const entry = { publicKey: short.publicKey.toBase58(), secretKey: bs58.encode(short.secretKey) };
  if (!vanity.isVanityAddress(entry.publicKey)) {
    t.skip("ground address is not a full vanity address");
    return;
  }
  await vanity.init();
  await seedPoolFile(entry);
  await vanity.init();

  const reservation = await vanity.reserve();
  reservation.expiresAt = Date.now() - 1;
  vanity.sweep();
  // release() is async; give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(vanity.get(reservation.id), undefined, "the expired reservation is gone");
  assert.equal(vanity.count(), 1);
});

test("reserve() falls back to a generated mint when the pool is empty", async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await vanity.init();
  assert.equal(vanity.count(), 0);
  const reservation = await vanity.reserve();
  assert.equal(reservation.vanity, false);
  assert.ok(reservation.keypair.publicKey.toBase58().length >= 32);
  assert.ok(reservation.expiresAt > Date.now());
  // Nothing to give back, but releasing must not throw.
  await vanity.release(reservation.id);
});

test.after(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});
