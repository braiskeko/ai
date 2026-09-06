/**
 * Offline demo data.
 *
 * Next's coins are real Meteora pools, so there is nothing to seed on a live
 * deployment: the indexer fills the database from the chain. This module only
 * exists so the UI can be worked on without an RPC connection, and it refuses to
 * run unless SEED_DEMO=1 on a non-mainnet cluster with no DBC config set.
 *
 * The coins it creates are clearly marked as demo, use fake (non-base58-checked
 * off-curve) mints and never appear next to real ones.
 */
import { Keypair } from "@solana/web3.js";
import { TOTAL_SUPPLY, type CurveState } from "@shared/schema";
import { config } from "./config";
import { configPubkey } from "./solana";
import { storage } from "./storage";
import { log } from "./vite";

interface DemoCoin {
  name: string;
  ticker: string;
  description: string;
  emoji: string;
  colors: readonly [string, string];
  /** progress towards graduation, 0..1 */
  progress: number;
  trades: number;
}

const DEMO_COINS: DemoCoin[] = [
  {
    name: "Demo Doge",
    ticker: "DDOGE",
    description: "[demo] Offline placeholder coin — no pool exists on chain.",
    emoji: "🐕",
    colors: ["#f7b955", "#e2762a"],
    progress: 0.62,
    trades: 24,
  },
  {
    name: "Demo Cat",
    ticker: "DCAT",
    description: "[demo] Offline placeholder coin — no pool exists on chain.",
    emoji: "🐈",
    colors: ["#7f5af0", "#2cb67d"],
    progress: 0.18,
    trades: 12,
  },
  {
    name: "Demo Frog",
    ticker: "DFROG",
    description: "[demo] Offline placeholder coin — no pool exists on chain.",
    emoji: "🐸",
    colors: ["#2cb67d", "#0f5132"],
    progress: 0.94,
    trades: 40,
  },
];

/** Deterministic 32-bit LCG so the demo history is stable across restarts. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A 256×256 inline-SVG logo: diagonal gradient with an emoji on top. */
export function coinImageDataUrl(emoji: string, colors: readonly [string, string]): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${escapeXml(colors[0])}"/><stop offset="100%" stop-color="${escapeXml(colors[1])}"/>` +
    `</linearGradient></defs>` +
    `<rect width="256" height="256" rx="48" fill="url(#g)"/>` +
    `<text x="50%" y="54%" font-size="128" text-anchor="middle" dominant-baseline="middle">${escapeXml(emoji)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function demoCurve(progress: number): CurveState {
  // A plausible curve: 85 SOL completes it, price grows with the reserve.
  const threshold = 85;
  const quoteReserveSol = threshold * progress;
  const priceSol = (0.00000003 + 0.0000004 * progress) * 1;
  return {
    quoteReserveSol,
    baseReserve: TOTAL_SUPPLY * (1 - progress * 0.8),
    priceSol,
    progress,
    solToGraduate: Math.max(0, threshold - quoteReserveSol),
    completed: progress >= 1,
    migrated: false,
    dammPool: null,
    slot: 0,
  };
}

/**
 * Fabricates three coins with a short trade history. No-op unless SEED_DEMO=1,
 * the cluster is not mainnet and no DBC config is configured (a configured
 * deployment gets its coins from the indexer).
 */
export function seedDemo(): void {
  if (!config.seedDemo) return;
  if (config.solana.cluster === "mainnet-beta" || configPubkey) {
    log("SEED_DEMO ignored: this deployment launches real coins", "seed");
    return;
  }
  if (storage.listCoins({ limit: 1 }).length > 0) return;

  const rand = lcg(1337);
  const now = Date.now();

  DEMO_COINS.forEach((demo, index) => {
    const mint = Keypair.generate().publicKey.toBase58();
    const pool = Keypair.generate().publicKey.toBase58();
    const creatorWallet = Keypair.generate().publicKey.toBase58();
    const createdAt = new Date(now - (index + 1) * 6 * 3_600_000).toISOString();
    const curve = demoCurve(demo.progress);

    const { coin } = storage.upsertCoinFromChain({
      ca: mint,
      pool,
      name: demo.name,
      ticker: demo.ticker,
      metadataUri: "",
      creatorWallet,
      curve,
      createdAt,
      createdTx: "demo",
      description: demo.description,
      imageUrl: coinImageDataUrl(demo.emoji, demo.colors),
    });

    const span = now - Date.parse(createdAt) - 60_000;
    for (let i = 0; i < demo.trades; i++) {
      const at = new Date(Date.parse(createdAt) + (span * (i + rand())) / demo.trades).toISOString();
      const buy = rand() > 0.35;
      const sol = 0.05 + rand() * 1.5;
      const priceSol = curve.priceSol * (0.4 + (0.6 * (i + 1)) / demo.trades);
      storage.recordTrade({
        coinId: coin.id,
        signature: `demo-${coin.id}-${i}`,
        wallet: Keypair.generate().publicKey.toBase58(),
        side: buy ? "buy" : "sell",
        sol,
        tokens: sol / priceSol,
        feeSol: sol * 0.027,
        priceSol,
        slot: 0,
        createdAt: at,
      });
    }
  });

  log(`seeded ${DEMO_COINS.length} demo coins (SEED_DEMO=1)`, "seed");
}
