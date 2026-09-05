/**
 * End-to-end smoke test + screenshots for the Noxia memecoin launchpad.
 *
 *   BASE_URL=http://localhost:5100 OUT_DIR=./screens node scripts/smoke.mjs
 *
 * Exercises the real API and UI: public pages, instant email login, faucet,
 * coin creation (CA ends in "noxia"), buy/sell with the 2.7% fee, comments,
 * portfolio/wallet pages, dark/light and mobile screenshots.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5100";
const OUT = process.env.OUT_DIR ?? "screens";
const EMAIL = process.env.SMOKE_EMAIL ?? "smoke@example.com";
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`FAIL ${name}: ${e.message}`);
  }
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1380, height: 900 }, baseURL: BASE });
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

const shot = (name, full = false) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
const api = async (method, url, body) => {
  const res = await context.request.fetch(BASE + url, {
    method,
    data: body,
    headers: body ? { "Content-Type": "application/json" } : {},
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()} ${text.slice(0, 200)}`);
  return json;
};

// 1x1 PNG data URL for the coin image
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg==";

let coins = [];
let cfg;
await step("GET /api/config", async () => {
  cfg = await api("GET", "/api/config");
  if (Math.abs(cfg.swapFee - 0.027) > 1e-9) throw new Error(`swapFee ${cfg.swapFee}`);
});
await step("GET /api/coins seeded", async () => {
  coins = await api("GET", "/api/coins?sort=mcap");
  if (!Array.isArray(coins) || coins.length < 5) throw new Error(`expected seeded coins, got ${coins.length}`);
  for (const c of coins) {
    if (c.ca.length !== 44 || !c.ca.endsWith("noxia")) throw new Error(`bad CA ${c.ca}`);
    if (!(c.marketCap > 0)) throw new Error(`bad mcap ${c.marketCap}`);
  }
});
await step("home renders", async () => {
  await page.goto("/", { waitUntil: "load" });
  await page.waitForTimeout(1200);
  await shot("01-home");
  await shot("01-home-full", true);
});
await step("coin page renders with chart", async () => {
  await page.goto(`/${coins[0].ca}`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await shot("02-coin");
});
await step("activity renders", async () => {
  await page.goto("/activity", { waitUntil: "load" });
  await page.waitForTimeout(600);
  await shot("03-activity");
});

let me = null;
await step("instant email login", async () => {
  if (!cfg.instantEmailLogin) throw new Error("instant login disabled");
  await api("POST", "/api/auth/email", { email: EMAIL });
  me = await api("GET", "/api/me");
});

if (me) {
  await step("faucet", async () => {
    if (!cfg.chain.testnet) return;
    try {
      me = await api("POST", "/api/wallet/faucet");
    } catch (e) {
      if (!/429/.test(e.message)) throw e;
      me = await api("GET", "/api/me");
    }
    if (me.balance <= 0) throw new Error(`balance ${me.balance}`);
  });
  let created;
  await step("create coin -> CA ends with noxia", async () => {
    created = await api("POST", "/api/coins", {
      name: "Smoke Cat",
      ticker: "SMOKE",
      description: "Created by the smoke test.",
      image: PNG,
      creatorAllocation: 0.05,
      initialBuy: 10,
    });
    if (!created.ca.endsWith("noxia") || created.ca.length !== 44) throw new Error(`bad CA ${created.ca}`);
    if (!(created.marketCap > 3000)) throw new Error(`mcap ${created.marketCap}`);
    if (!created.imageUrl.startsWith("/uploads/")) throw new Error(`imageUrl ${created.imageUrl}`);
  });
  await step("buy then sell applies 2.7% fee", async () => {
    const before = await api("GET", "/api/me");
    const q = await api("POST", `/api/coins/${created.ca}/quote`, { side: "buy", amount: 50 });
    if (Math.abs(q.fee - 50 * 0.027) > 1e-6) throw new Error(`fee ${q.fee}`);
    const t = await api("POST", `/api/coins/${created.ca}/trade`, { side: "buy", amount: 50 });
    if (!(t.coin.price > created.price)) throw new Error("price did not rise after buy");
    const after = await api("GET", "/api/me");
    if (Math.abs(before.balance - after.balance - 50) > 1e-6) throw new Error("balance not debited by 50");
    const s = await api("POST", `/api/coins/${created.ca}/trade`, { side: "sell", amount: t.trade.tokens / 2 });
    if (!(s.trade.usdc > 0 && s.trade.usdc < 25)) throw new Error(`sell usdc ${s.trade.usdc}`);
    const detail = await api("GET", `/api/coins/${created.ca}`);
    if (detail.recentTrades.length < 3) throw new Error("trades missing");
    if (detail.candles.length < 1) throw new Error("candles missing");
    if (!(detail.creatorFees > 0)) throw new Error("creator fees not credited");
  });
  await step("comment", async () => {
    const c = await api("POST", `/api/coins/${created.ca}/comments`, { body: "gm from the smoke test" });
    if (c.body !== "gm from the smoke test") throw new Error("comment body");
    await api("POST", `/api/comments/${c.id}/like`);
  });
  await step("coin page logged in", async () => {
    await page.goto(`/${created.ca}`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    await shot("04-coin-logged-in");
  });
  await step("create page", async () => {
    await page.goto("/create", { waitUntil: "load" });
    await page.waitForTimeout(600);
    await shot("05-create");
  });
  await step("portfolio + wallet", async () => {
    const pf = await api("GET", "/api/portfolio");
    if (!pf.holdings.some((h) => h.coin.ca === created.ca)) throw new Error("holding missing");
    await page.goto("/portfolio", { waitUntil: "load" });
    await page.waitForTimeout(600);
    await shot("06-portfolio");
    await page.goto("/wallet", { waitUntil: "load" });
    await page.waitForTimeout(600);
    await shot("07-wallet");
  });
  await step("spanish locale", async () => {
    await page.evaluate(() => localStorage.setItem("locale", "es"));
    await page.goto("/", { waitUntil: "load" });
    await page.waitForTimeout(1000);
    const text = await page.textContent("body");
    if (!/Gana el 10%|Crear/i.test(text ?? "")) throw new Error("spanish strings not rendered");
    await shot("08-home-es");
    await page.evaluate(() => localStorage.removeItem("locale"));
  });
  await step("light theme", async () => {
    await page.evaluate(() => {
      localStorage.setItem("theme", "light");
      document.documentElement.classList.remove("dark");
    });
    await page.goto(`/${coins[0].ca}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await shot("09-coin-light");
    await page.evaluate(() => localStorage.removeItem("theme"));
  });
  await step("mobile", async () => {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: BASE, isMobile: true });
    await mobile.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
    const mp = await mobile.newPage();
    await mp.goto("/", { waitUntil: "load" });
    await mp.waitForTimeout(800);
    await mp.screenshot({ path: path.join(OUT, "10-mobile-home.png") });
    await mp.goto(`/${coins[0].ca}`, { waitUntil: "load" });
    await mp.waitForTimeout(1200);
    await mp.screenshot({ path: path.join(OUT, "11-mobile-coin.png"), fullPage: true });
    await mobile.close();
  });
}

await browser.close();
const realErrors = consoleErrors.filter(
  (e) => !/favicon|ResizeObserver|WebSocket connection to|ERR_FAILED|ERR_CONNECTION_RESET|401 \(Unauthorized\)/.test(e),
);
if (realErrors.length) {
  console.log("\nBrowser console errors:");
  for (const e of realErrors) console.log("  " + e);
}
if (failures.length || realErrors.length) {
  console.log(`\n${failures.length} failed step(s), ${realErrors.length} console error(s)`);
  process.exit(1);
}
console.log("\nAll smoke steps passed. Screenshots in", OUT);
