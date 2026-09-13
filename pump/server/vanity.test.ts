import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { CA_SUFFIX } from "@shared/schema";
import { VanityPool, verifyKeypair, type VanityKeypair } from "./vanity";

/**
 * Real "…next" addresses take billions of tries to grind, so the tests use a
 * pool with an empty suffix (which accepts any valid address) plus one explicit
 * check that the real suffix rule is enforced.
 */
async function tmpPool(suffix = ""): Promise<{ dir: string; pool: VanityPool }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "next-vanity-"));
  const pool = new VanityPool(dir, suffix);
  await pool.init();
  return { dir, pool };
}

function keypairEntry(): VanityKeypair {
  const kp = Keypair.generate();
  return { publicKey: kp.publicKey.toBase58(), secretKey: bs58.encode(kp.secretKey) };
}

test("verifyKeypair accepts a real pair and rejects everything else", () => {
  const entry = keypairEntry();
  const other = keypairEntry();
  assert.ok(verifyKeypair(entry));
  assert.equal(verifyKeypair({ publicKey: other.publicKey, secretKey: entry.secretKey }), null);
  assert.equal(verifyKeypair({ publicKey: entry.publicKey, secretKey: "not base58 !!" }), null);
  assert.equal(verifyKeypair({ publicKey: entry.publicKey, secretKey: bs58.encode(new Uint8Array(32)) }), null);
});

test("the real pool only accepts addresses ending in the Next suffix", async () => {
  const { dir, pool } = await tmpPool(CA_SUFFIX);
  try {
    const entry = keypairEntry();
    assert.equal(pool.accepts(entry.publicKey), entry.publicKey.endsWith(CA_SUFFIX));
    const result = await pool.add([entry]);
    assert.equal(result.added, 0);
    assert.equal(result.rejected, 1);
    assert.equal(pool.count(), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("add() stores keypairs, skips duplicates and rejects broken pairs", async () => {
  const { dir, pool } = await tmpPool();
  try {
    const a = keypairEntry();
    const b = keypairEntry();
    const broken = { publicKey: keypairEntry().publicKey, secretKey: a.secretKey };

    const first = await pool.add([a, b, broken]);
    assert.deepEqual({ added: first.added, available: first.available, rejected: first.rejected }, {
      added: 2,
      available: 2,
      rejected: 1,
    });

    const again = await pool.add([a]);
    assert.equal(again.added, 0, "the same mint is never stored twice");
    assert.equal(pool.count(), 2);

    // The files are really on disk and survive a reload.
    const reloaded = new VanityPool(dir, "");
    await reloaded.init();
    assert.equal(reloaded.count(), 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reserve() hands out a stored mint and moves it into used/", async () => {
  const { dir, pool } = await tmpPool();
  try {
    const entry = keypairEntry();
    await pool.add([entry]);

    const reservation = await pool.reserve();
    assert.equal(reservation.vanity, true);
    assert.equal(reservation.keypair.publicKey.toBase58(), entry.publicKey);
    assert.equal(pool.count(), 0, "a reserved mint leaves the pool");
    assert.equal(pool.usedCount(), 1);
    assert.ok(reservation.expiresAt > Date.now());
    assert.equal(pool.get(reservation.id), reservation);
    await fs.access(path.join(dir, "used", `${entry.publicKey}.json`));

    // A consumed reservation is gone for good.
    pool.consume(reservation.id);
    assert.equal(pool.get(reservation.id), undefined);
    assert.equal(pool.count(), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an abandoned reservation returns its mint to the pool", async () => {
  const { dir, pool } = await tmpPool();
  try {
    const entry = keypairEntry();
    await pool.add([entry]);
    const reservation = await pool.reserve();
    assert.equal(pool.count(), 0);

    await pool.release(reservation.id);
    assert.equal(pool.count(), 1, "the released mint is available again");
    assert.equal(pool.usedCount(), 0);
    assert.equal(pool.get(reservation.id), undefined);

    // And it can be handed out again.
    const second = await pool.reserve();
    assert.equal(second.keypair.publicKey.toBase58(), entry.publicKey);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("expired reservations are swept back into the pool", async () => {
  const { dir, pool } = await tmpPool();
  try {
    await pool.add([keypairEntry()]);
    const reservation = await pool.reserve();
    assert.equal(pool.count(), 0);

    reservation.expiresAt = Date.now() - 1;
    pool.sweep();
    await new Promise((resolve) => setTimeout(resolve, 20)); // release() is async
    assert.equal(pool.get(reservation.id), undefined, "the expired reservation is gone");
    assert.equal(pool.count(), 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a used mint is never re-added by a careless uploader", async () => {
  const { dir, pool } = await tmpPool();
  try {
    const entry = keypairEntry();
    await pool.add([entry]);
    const reservation = await pool.reserve();
    pool.consume(reservation.id);

    const result = await pool.add([entry]);
    assert.equal(result.added, 0);
    assert.equal(pool.count(), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reserve() falls back to a generated mint when the pool is empty", async () => {
  const { dir, pool } = await tmpPool();
  try {
    assert.equal(pool.count(), 0);
    const reservation = await pool.reserve();
    assert.equal(reservation.vanity, false);
    assert.equal(reservation.keypair.publicKey.toBase58().length >= 32, true);
    // Nothing to give back, but releasing must not throw or invent a file.
    await pool.release(reservation.id);
    assert.equal(pool.count(), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt file is dropped instead of being handed out", async () => {
  const { dir, pool } = await tmpPool();
  try {
    const entry = keypairEntry();
    await fs.writeFile(path.join(dir, `${entry.publicKey}.json`), "{ not json");
    await pool.init();
    assert.equal(pool.count(), 1);

    const reservation = await pool.reserve();
    assert.equal(reservation.vanity, false, "falls back to a generated mint");
    assert.equal(pool.count(), 0);
    await assert.rejects(() => fs.access(path.join(dir, `${entry.publicKey}.json`)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
