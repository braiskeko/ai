import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, promises as fs } from "fs";
import os from "os";
import path from "path";

// meta.ts resolves META_DIR and APP_URL at import time, so the environment has
// to be in place before the module is pulled in.
const DIR = mkdtempSync(path.join(os.tmpdir(), "next-meta-"));
process.env.META_DIR = DIR;
process.env.APP_URL = "https://app.noxia.work";
const meta = import("./meta");

const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

test("relative upload paths become absolute URLs", async () => {
  const { absoluteUrl } = await meta;
  assert.equal(absoluteUrl("/uploads/coins/x.webp"), "https://app.noxia.work/uploads/coins/x.webp");
  assert.equal(absoluteUrl("uploads/coins/x.webp"), "https://app.noxia.work/uploads/coins/x.webp");
  assert.equal(absoluteUrl("https://cdn.test/x.png"), "https://cdn.test/x.png");
});

test("the metadata uri points back at our own /api/meta endpoint", async () => {
  const { metadataUri, mintFromMetadataUri } = await meta;
  assert.equal(metadataUri(MINT), `https://app.noxia.work/api/meta/${MINT}.json`);
  assert.equal(mintFromMetadataUri(metadataUri(MINT)), MINT);
  assert.equal(mintFromMetadataUri("https://pump.fun/api/meta/other.json"), null);
  assert.equal(mintFromMetadataUri(`https://evil.test/api/meta/${MINT}.json`), null, "only our own host is trusted");
});

test("buildTokenMetadata produces the Metaplex off-chain document", async () => {
  const { buildTokenMetadata } = await meta;
  const doc = buildTokenMetadata({
    name: "Next Cat",
    ticker: "NCAT",
    description: "the best cat",
    imageUrl: "/uploads/coins/ncat.webp",
    website: "https://cat.test",
    twitter: "https://x.com/cat",
    telegram: null,
  });

  assert.equal(doc.name, "Next Cat");
  assert.equal(doc.symbol, "NCAT");
  assert.equal(doc.image, "https://app.noxia.work/uploads/coins/ncat.webp");
  assert.equal(doc.external_url, "https://cat.test");
  assert.deepEqual(doc.extensions, { website: "https://cat.test", twitter: "https://x.com/cat" });
  assert.equal(doc.properties?.files?.[0]?.uri, doc.image);
});

test("the coin fields we store round-trip through the document", async () => {
  const { buildTokenMetadata, coinFieldsFromMetadata, readTokenMetadata, saveTokenMetadata } = await meta;
  const doc = buildTokenMetadata({
    name: "Next Cat",
    ticker: "NCAT",
    description: "the best cat",
    imageUrl: "/uploads/coins/ncat.webp",
    website: null,
    twitter: null,
    telegram: "https://t.me/cat",
  });
  await saveTokenMetadata(MINT, doc);

  const loaded = await readTokenMetadata(MINT);
  assert.deepEqual(loaded, doc);
  assert.deepEqual(coinFieldsFromMetadata(loaded!), {
    description: "the best cat",
    imageUrl: "https://app.noxia.work/uploads/coins/ncat.webp",
    website: null,
    twitter: null,
    telegram: "https://t.me/cat",
  });
});

test("an unknown mint reads back as null", async () => {
  const { readTokenMetadata } = await meta;
  assert.equal(await readTokenMetadata("9pM1DN3RiT8vbom5u1sNryaNT1nyL8CTTW3b5PwWXRBH"), null);
  assert.equal(await readTokenMetadata("../../etc/passwd"), null, "path traversal is refused");
});

test.after(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});
