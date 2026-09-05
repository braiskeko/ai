/**
 * End-to-end smoke test + screenshot run.
 *
 * Usage:  BASE_URL=http://localhost:5000 OUT_DIR=./screens node scripts/smoke.mjs
 *
 * Requires Playwright (uses the global install when NODE_PATH points at it, e.g.
 * NODE_PATH=$(npm root -g)). Exercises the real HTTP API and the UI:
 *   - public pages render (landing, markets, market detail, activity, leaderboard)
 *   - magic-link sign in (dev mode: link returned by the API)
 *   - testnet faucet, a buy and a sell, portfolio + wallet render
 *   - market creation (pending review) and, when the user is admin, approval
 * Fails (exit 1) on any console error or failed step.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5000";
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
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
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

let markets = [];
await step("GET /api/config", async () => {
  const cfg = await api("GET", "/api/config");
  if (!cfg.chain?.name) throw new Error("config missing chain");
});
await step("GET /api/markets", async () => {
  markets = await api("GET", "/api/markets");
  if (!Array.isArray(markets) || markets.length < 5) throw new Error(`expected seeded markets, got ${markets.length}`);
  const m = markets[0];
  const sum = m.prices.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-6) throw new Error(`prices do not sum to 1: ${sum}`);
});

await step("landing renders", async () => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot("01-landing");
  await page.screenshot({ path: path.join(OUT, "01-landing-full.png"), fullPage: true });
});
await step("markets page renders cards", async () => {
  await page.goto("/markets", { waitUntil: "networkidle" });
  await page.waitForSelector('a[href^="/market/"]', { timeout: 15000 });
  await shot("02-markets");
});
const multi = markets.find((m) => !m.binary && m.status === "open") ?? markets[0];
const binary = markets.find((m) => m.binary && m.status === "open") ?? markets[0];
await step("binary market detail renders", async () => {
  await page.goto(`/market/${binary.slug}`, { waitUntil: "networkidle" });
  await page.waitForSelector("h1", { timeout: 15000 });
  await page.waitForTimeout(800);
  await shot("03-market-binary");
});
await step("multi-outcome market detail renders", async () => {
  await page.goto(`/market/${multi.slug}`, { waitUntil: "networkidle" });
  await page.waitForSelector("h1", { timeout: 15000 });
  await page.waitForTimeout(800);
  await shot("04-market-multi");
});
await step("activity + leaderboard render", async () => {
  await page.goto("/activity", { waitUntil: "networkidle" });
  await shot("05-activity");
  await page.goto("/leaderboard", { waitUntil: "networkidle" });
  await shot("06-leaderboard");
});

let me = null;
await step("email sign in (instant or magic link dev mode)", async () => {
  const cfg = await api("GET", "/api/config");
  if (cfg.instantEmailLogin) {
    await api("POST", "/api/auth/email", { email: EMAIL });
  } else {
    const r = await api("POST", "/api/auth/magic", { email: EMAIL });
    if (!r.devLink) throw new Error("no devLink returned (email provider configured?) — skipping authenticated steps");
    await page.goto(r.devLink, { waitUntil: "networkidle" });
  }
  me = await api("GET", "/api/me");
  if (me.email !== EMAIL) throw new Error(`unexpected user ${JSON.stringify(me)}`);
});

if (me) {
  await step("faucet credits test USDC", async () => {
    const cfg = await api("GET", "/api/config");
    if (!cfg.chain.testnet) return;
    me = await api("POST", "/api/wallet/faucet");
    if (me.balance < 1000) throw new Error(`balance ${me.balance}`);
  });
  await step("buy then sell on a binary market", async () => {
    const before = await api("GET", `/api/markets/${binary.slug}`);
    const q = await api("POST", `/api/markets/${binary.id}/quote`, { outcomeId: 0, side: "buy", amount: 25 });
    if (!(q.shares > 25)) throw new Error(`expected > 25 shares for $25 at ${before.prices[0]}, got ${q.shares}`);
    const t = await api("POST", `/api/markets/${binary.id}/trade`, { outcomeId: 0, side: "buy", amount: 25 });
    if (t.market.prices[0] <= before.prices[0]) throw new Error("price did not move up after buy");
    const half = t.trade.shares / 2;
    const s = await api("POST", `/api/markets/${binary.id}/trade`, { outcomeId: 0, side: "sell", amount: half });
    if (!(s.trade.amount > 0 && s.trade.amount < 25)) throw new Error(`sell amount ${s.trade.amount}`);
    const pf = await api("GET", "/api/portfolio");
    if (!pf.positions.some((p) => p.marketId === binary.id)) throw new Error("position missing in portfolio");
  });
  await step("trade panel UI renders with balance", async () => {
    await page.goto(`/market/${binary.slug}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await shot("07-market-logged-in");
  });
  await step("portfolio renders", async () => {
    await page.goto("/portfolio", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await shot("08-portfolio");
  });
  await step("wallet renders", async () => {
    await page.goto("/wallet", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await shot("09-wallet");
  });
  await step("create market -> pending or open", async () => {
    const end = new Date(Date.now() + 30 * 86400_000).toISOString();
    const m = await api("POST", "/api/markets", {
      question: "Will the smoke test market be approved by moderators?",
      description: "Created automatically by scripts/smoke.mjs to exercise the review flow.",
      rules: "Resolves Yes if an admin approves this market in the admin panel before the end date.",
      category: "Tech",
      imageEmoji: "🧪",
      endDate: end,
      outcomes: ["Yes", "No"],
      liquidity: 500,
    });
    if (!["pending", "open"].includes(m.status)) throw new Error(`unexpected status ${m.status}`);
    const mine = await api("GET", "/api/me/markets");
    if (!mine.some((x) => x.id === m.id)) throw new Error("created market missing from /api/me/markets");
    if (me.isAdmin && m.status === "pending") {
      const r = await api("POST", `/api/admin/markets/${m.id}/review`, { action: "approve", featured: false });
      if (r.status !== "open") throw new Error(`approve -> ${r.status}`);
    }
  });
  await step("create page renders", async () => {
    await page.goto("/create", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await shot("10-create");
  });
  if (me.isAdmin) {
    await step("admin page renders", async () => {
      await page.goto("/admin", { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      await shot("11-admin");
    });
  }
  await step("dark theme screenshot", async () => {
    await page.evaluate(() => {
      localStorage.setItem("theme", "dark");
      document.documentElement.classList.add("dark");
    });
    await page.goto("/markets", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await shot("12-markets-dark");
    await page.goto(`/market/${multi.slug}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await shot("13-market-dark");
  });
  await step("mobile viewport", async () => {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: BASE, isMobile: true });
    const mp = await mobile.newPage();
    await mp.goto("/markets", { waitUntil: "networkidle" });
    await mp.waitForTimeout(600);
    await mp.screenshot({ path: path.join(OUT, "14-mobile-markets.png") });
    await mp.goto(`/market/${binary.slug}`, { waitUntil: "networkidle" });
    await mp.waitForTimeout(600);
    await mp.screenshot({ path: path.join(OUT, "15-mobile-market.png"), fullPage: true });
    await mobile.close();
  });
}

await browser.close();

const realErrors = consoleErrors.filter((e) => !/favicon|ResizeObserver|WebSocket connection to/.test(e));
if (realErrors.length) {
  console.log("\nBrowser console errors:");
  for (const e of realErrors) console.log("  " + e);
}
if (failures.length || realErrors.length) {
  console.log(`\n${failures.length} failed step(s), ${realErrors.length} console error(s)`);
  process.exit(1);
}
console.log("\nAll smoke steps passed. Screenshots in", OUT);
