import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

// meta.ts resolves META_DIR and APP_URL at import time.
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), "noxia-meta-"));
process.env.META_DIR = DIR;
process.env.APP_URL = "https://app.noxia.work";

const { absoluteUrl, buildTokenMetadata, coinFieldsFromMetadata, metadataUri, mintFromMetadataUri, readTokenMetadata, saveTokenMetadata } =
  await import("./meta");

const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

test("relative upload paths become absolute URLs", () => {
  assert.equal(absoluteUrl("/uploads/coins/x.webp"), "https://app.noxia.work/uploads/coins/x.webp");
  assert.equal(absoluteUrl("uploads/coins/x.webp"), "https://app.noxia.work/uploads/coins/x.webp");
  assert.equal(absoluteUrl("https://cdn.test/x.png"), "https://cdn.test/x.png");
});

test("the metadata uri points back at our own /api/meta endpoint", () => {
  assert.equal(metadataUri(MINT), `https://app.noxia.work/api/meta/${MINT}.json`);
  assert.equal(mintFromMetadataUri(metadataUri(MINT)), MINT);
  assert.equal(mintFromMetadataUri("https://pump.fun/api/meta/other.json"), null);
  assert.equal(mintFromMetadataUri(`https://evil.test/api/meta/${MINT}.json`), null, "only our own host is trusted");
});

test("buildTokenMetadata produces the Metaplex off-chain document", () => {
  const meta = buildTokenMetadata({
    name: "Noxia Cat",
    ticker: "NCAT",
    description: "the best cat",
    imageUrl: "/uploads/coins/ncat.webp",
    website: "https://cat.test",
    twitter: "https://x.com/cat",
    telegram: null,
  });

  assert.equal(meta.name, "Noxia Cat");
  assert.equal(meta.symbol, "NCAT");
  assert.equal(meta.image, "https://app.noxia.work/uploads/coins/ncat.webp");
  assert.equal(meta.external_url, "https://cat.test");
  assert.deepEqual(meta.extensions, { website: "https://cat.test", twitter: "https://x.com/cat" });
  assert.equal(meta.properties?.files?.[0]?.uri, meta.image);
});

test("the coin fields we store round-trip through the document", async () => {
  const meta = buildTokenMetadata({
    name: "Noxia Cat",
    ticker: "NCAT",
    description: "the best cat",
    imageUrl: "/uploads/coins/ncat.webp",
    website: null,
    twitter: null,
    telegram: "https://t.me/cat",
  });
  await saveTokenMetadata(MINT, meta);

  const loaded = await readTokenMetadata(MINT);
  assert.deepEqual(loaded, meta);
  assert.deepEqual(coinFieldsFromMetadata(loaded!), {
    description: "the best cat",
    imageUrl: "https://app.noxia.work/uploads/coins/ncat.webp",
    website: null,
    twitter: null,
    telegram: "https://t.me/cat",
  });
});

test("an unknown mint reads back as null", async () => {
  assert.equal(await readTokenMetadata("9pM1DN3RiT8vbom5u1sNryaNT1nyL8CTTW3b5PwWXRBH"), null);
  assert.equal(await readTokenMetadata("../../etc/passwd"), null, "path traversal is refused");
});

test.after(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});
