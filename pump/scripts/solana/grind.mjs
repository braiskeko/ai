/**
 * Grind Solana mint addresses that end in "next" and push them to the platform pool.
 *
 *   node pump/scripts/solana/grind.mjs --count 5 --out ./vanity
 *   API=https://app.noxia.work ADMIN_API_TOKEN=... node pump/scripts/solana/grind.mjs --count 5 --upload
 *
 * Options
 *   --count N     how many addresses to find (default 1)
 *   --suffix S    suffix to look for (default "next"; base58 only, no 0 O I l)
 *   --workers N   worker threads (default: number of CPUs)
 *   --out DIR     write <pubkey>.json keypair files there (default ./vanity)
 *   --upload      POST each key to $API/api/admin/vanity with x-admin-token
 *
 * Cost: the four-character suffix "next" is 58^4 ≈ 11.3 million tries. This script does
 * roughly 5,000 tries/second per core, so one address takes about 40 core-minutes —
 * a few minutes on a normal laptop. Rust's `solana-keygen grind --ends-with next:10`
 * is faster still and writes the same JSON keypair files, which this script can upload.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { webcrypto } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function grindLoop(suffix, report) {
  const seed = new Uint8Array(32);
  let tries = 0;
  for (;;) {
    webcrypto.getRandomValues(seed);
    const pub = ed25519.getPublicKey(seed);
    tries++;
    const address = bs58.encode(pub);
    if (address.endsWith(suffix)) {
      // Solana keypair files hold the 64-byte secret: 32-byte seed followed by the public key.
      const secret = new Uint8Array(64);
      secret.set(seed, 0);
      secret.set(pub, 32);
      report({ found: { address, secret: Array.from(secret) }, tries });
      tries = 0;
    } else if (tries % 20_000 === 0) {
      report({ tries });
      tries = 0;
    }
  }
}

if (!isMainThread) {
  grindLoop(workerData.suffix, (msg) => parentPort.postMessage(msg));
} else {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
  };
  const has = (name) => args.includes(`--${name}`);

  const suffix = flag("suffix", "next");
  const want = Number(flag("count", "1"));
  const workers = Number(flag("workers", String(os.cpus().length)));
  const outDir = path.resolve(flag("out", "./vanity"));
  const upload = has("upload");
  const api = (process.env.API || "http://localhost:5000").replace(/\/+$/, "");
  const token = process.env.ADMIN_API_TOKEN || "";

  for (const ch of suffix) {
    if (!BASE58.includes(ch)) {
      console.error(`"${ch}" is not a base58 character — 0, O, I and l can never appear in an address`);
      process.exit(2);
    }
  }
  if (upload && !token) {
    console.error("ADMIN_API_TOKEN is required with --upload");
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const space = Math.pow(58, suffix.length);
  console.log(
    `grinding ${want} address(es) ending in "${suffix}" with ${workers} workers — 1 in ${space.toLocaleString()} keys matches`,
  );

  const pool = [];
  let found = 0;
  let tries = 0;
  const started = Date.now();

  const post = async (address, secret) => {
    const res = await fetch(`${api}/api/admin/vanity`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": token },
      body: JSON.stringify({ keypairs: [{ publicKey: address, secretKey: bs58.encode(Uint8Array.from(secret)) }] }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`);
    console.log(`  uploaded → ${body.slice(0, 120)}`);
  };

  const onMessage = async (msg) => {
    tries += msg.tries ?? 0;
    if (!msg.found) {
      const rate = Math.round(tries / ((Date.now() - started) / 1000));
      process.stdout.write(`\r${tries.toLocaleString()} keys, ${rate.toLocaleString()}/s, ${found}/${want} found   `);
      return;
    }
    found++;
    const { address, secret } = msg.found;
    const file = path.join(outDir, `${address}.json`);
    fs.writeFileSync(file, JSON.stringify(secret), { mode: 0o600 });
    console.log(`\nfound ${address} (${tries.toLocaleString()} keys) → ${file}`);
    if (upload) {
      try {
        await post(address, secret);
      } catch (e) {
        console.error(`  upload failed: ${e.message} (the file is still on disk)`);
      }
    }
    if (found >= want) {
      for (const w of pool) void w.terminate();
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`done: ${found} address(es) in ${mins} min`);
      process.exit(0);
    }
  };

  for (let i = 0; i < workers; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { suffix } });
    w.on("message", onMessage);
    w.on("error", (e) => console.error("worker error", e));
    pool.push(w);
  }
}
