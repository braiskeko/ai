import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { createServer, type IncomingMessage, type Server } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
// @ts-ignore -- @types/cookie-parser is not installed (run `npm i -D @types/cookie-parser`); the runtime package is.
import cookieParser from "cookie-parser";
import { PublicKey } from "@solana/web3.js";
import { z, ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import {
  CREATOR_FEE_SHARE,
  GRADUATION_MCAP_USD,
  LAUNCH_MCAP_USD,
  CHAINS,
  SOLANA_ADDRESS_RE,
  parseTokenId,
  SWAP_FEE,
  TOKEN_DECIMALS,
  TOTAL_SUPPLY,
  commentSchema,
  thesisSchema,
  THESIS_COOLDOWN_MS,
  createTxSchema,
  externalQuoteSchema,
  externalSwapTxSchema,
  followSchema,
  idTokenSchema,
  magicLinkRequestSchema,
  prepareCoinSchema,
  quoteSchema,
  sendTxSchema,
  swapTxSchema,
  updateProfileSchema,
  vanityUploadSchema,
  walletLoginSchema,
  type ActivityItem,
  type AdminOverview,
  type AppConfig,
  type AuthProvider,
  type Chain,
  type Coin,
  type CoinDetail,
  type CoinSummary,
  type CommentView,
  type ExternalToken,
  type ExternalTokenDetail,
  type FeedEntry,
  type Holding,
  type HolderRow,
  type MyRank,
  type Portfolio,
  type PreparedCoin,
  type SentTx,
  type TraderRank,
  type UnsignedTx,
  type User,
  type WalletView,
} from "@shared/schema";
import { HttpError, storage } from "./storage";
import {
  buildMagicLink,
  clearSessionCookie,
  consumeMagicToken,
  createMagicToken,
  getUserFromRequest,
  requireAdmin,
  requireAuth,
  setSessionCookie,
  verifyAppleIdToken,
  verifyGoogleIdToken,
} from "./auth";
import { config } from "./config";
import { magicLinkDevMode, sendMagicLink } from "./email";
import * as indexer from "./indexer";
import * as jupiter from "./jupiter";
import * as markets from "./markets";
import * as hyperliquid from "./hyperliquid";
import { buildTokenMetadata, metadataUri, readTokenMetadata, saveTokenMetadata } from "./meta";
import {
  buildClaimCreatorFeeTx,
  buildClaimPartnerFeeTx,
  buildCreateTx,
  buildSwapTx,
  clusterInfo,
  explorerUrl,
  getPoolFees,
  getSolBalance,
  getSolUsd,
  getTokenAccountOwners,
  getTokenBalances,
  getTopHolders,
  launchEnabled,
  poolStateOf,
  quote as quoteSwap,
  readPoolState,
  sendSignedTx,
  treasuryPubkey,
} from "./solana";
import { imageProxy } from "./imgproxy";
import { UPLOADS_ROOT, deleteImage, saveImage } from "./uploads";
import * as vanity from "./vanity";
import { log } from "./vite";
import { issueWalletNonce, verifyWalletLogin } from "./walletAuth";

// ---------------------------------------------------------------------------
// Realtime (WebSocket) fan-out
// ---------------------------------------------------------------------------

const WS_PATH = "/ws";
const WS_HEARTBEAT_MS = 30_000;

let wss: WebSocketServer | null = null;

/**
 * Push an event to every connected client. Frames carry the payload three ways
 * so the client can read whichever it prefers:
 * `{event, type, payload: {...}, ...payload}`.
 */
export function broadcast(event: string, payload: Record<string, unknown>): void {
  if (!wss || wss.clients.size === 0) return;
  const message = JSON.stringify({ event, type: event, payload, ...payload });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

/** Terminate every WebSocket client so `server.close()` can complete during shutdown. */
export function closeRealtime(): void {
  if (!wss) return;
  const server = wss;
  wss = null;
  server.clients.forEach((client) => client.terminate());
  server.close();
}

function setupRealtime(httpServer: Server): WebSocketServer {
  // noServer: we route upgrades ourselves. `new WebSocketServer({ server, path })` would answer
  // every non-matching upgrade with a 400, which breaks Vite's HMR socket in development.
  const server = new WebSocketServer({ noServer: true });
  const alive = new WeakSet<WebSocket>();

  server.on("connection", (socket) => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    socket.on("error", (err) => log(`client socket error: ${err.message}`, "ws"));
  });

  const heartbeat = setInterval(() => {
    server.clients.forEach((client) => {
      if (!alive.has(client)) {
        client.terminate();
        return;
      }
      alive.delete(client);
      client.ping();
    });
  }, WS_HEARTBEAT_MS);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname !== WS_PATH) {
      // In development Vite attaches its own upgrade listener for HMR; leave those sockets alone.
      if (!config.isProd) return;
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    server.handleUpgrade(req, socket, head, (ws) => server.emit("connection", ws, req));
  });

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => unknown;

/** Run a (possibly async) handler and forward sync throws and rejections to the error middleware. */
const wrap =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };

function parseId(raw: string): number {
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "Invalid id");
  return id;
}

/** The signed-in user. Routes using this are also guarded by requireAuth; this narrows the type. */
function currentUser(req: Request): User {
  if (!req.user) throw new HttpError(401, "Sign in required");
  return req.user;
}

/** The signed-in user together with their linked wallet (402-style guard for trading). */
function currentWallet(req: Request): { user: User; wallet: string } {
  const user = currentUser(req);
  if (!user.walletAddress) throw new HttpError(400, "Connect a Solana wallet first");
  return { user, wallet: user.walletAddress };
}

function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(queryString(raw)));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, n));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function isMint(value: string): boolean {
  return SOLANA_ADDRESS_RE.test(value);
}

/** The stored coin for a `:ca` route parameter, or 404. */
function coinByCa(ca: string): Coin {
  const coin = isMint(ca) ? storage.findCoinByCa(ca) : undefined;
  if (!coin) throw new HttpError(404, "Coin not found");
  return coin;
}

const coinListQuerySchema = z.object({
  sort: z.enum(["new", "trending", "mcap", "volume", "graduated"]).optional().catch(undefined),
  search: z.string().trim().min(1).max(100).optional().catch(undefined),
});

/** `?list=` on /api/tokens; anything unknown falls back to the trending feed. */
const tokenListQuerySchema = z.enum(["trending", "top", "new"]).catch("trending");

const avatarSchema = z.object({
  image: z.string().regex(/^data:image\/(png|jpe?g|webp|gif);base64,/, "Upload an image").max(2_000_000),
});

const claimSchema = z.object({ ca: z.string().regex(SOLANA_ADDRESS_RE) });

/** Fixed-window-per-key limiter kept in memory; plenty for a single-process deployment. */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    const sweep = setInterval(() => this.sweep(), windowMs);
    sweep.unref();
  }

  isLimited(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  record(key: string): void {
    const times = this.recent(key);
    times.push(Date.now());
    this.hits.set(key, times);
  }

  /** Throw 429 (with Retry-After) when `key` has exhausted its window. */
  check(key: string, res: Response, message: string): void {
    if (!this.isLimited(key)) return;
    res.set("Retry-After", String(Math.ceil(this.windowMs / 1000)));
    throw new HttpError(429, message);
  }

  private recent(key: string): number[] {
    const now = Date.now();
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  private sweep(): void {
    const now = Date.now();
    this.hits.forEach((times, key) => {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    });
  }
}

const MAGIC_LINK_WINDOW_MS = 15 * 60 * 1000;
const magicLinkLimiter = new RateLimiter(5, MAGIC_LINK_WINDOW_MS);
const walletNonceLimiter = new RateLimiter(30, 10 * 60 * 1000);
const walletLoginLimiter = new RateLimiter(20, 15 * 60 * 1000);
/** Coin creation: 5 prepares per user per hour. */
const coinCreateLimiter = new RateLimiter(5, 60 * 60 * 1000);
const commentLimiter = new RateLimiter(20, 60 * 1000);
/** Transaction building hits the RPC; keep it civil. */
const txLimiter = new RateLimiter(60, 60 * 1000);
/** External quotes are proxied to Jupiter uncached, so they get their own budget. */
const externalQuoteLimiter = new RateLimiter(120, 60 * 1000);

// ---------------------------------------------------------------------------
// Pending coin creations
// ---------------------------------------------------------------------------

interface Prepared {
  id: string;
  userId: number;
  mint: string;
  vanity: boolean;
  name: string;
  ticker: string;
  description: string;
  imageUrl: string;
  metadataUri: string;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  expiresAt: number;
}

/** prepareId -> everything /api/coins/create-tx needs. Mirrors the vanity reservation TTL. */
const prepared = new Map<string, Prepared>();

function sweepPrepared(now = Date.now()): void {
  prepared.forEach((entry, id) => {
    if (entry.expiresAt > now) return;
    prepared.delete(id);
    void vanity.release(id);
  });
}

// ---------------------------------------------------------------------------
// Chain enrichment (best effort: a dead RPC must never 500 a page)
// ---------------------------------------------------------------------------

/** Replaces the indexed holder list with the real one from the chain. */
async function chainHolders(coin: Coin): Promise<{ rows: HolderRow[]; total: number } | null> {
  try {
    const { holders, total } = await getTopHolders(coin.ca);
    if (holders.length === 0) return { rows: [], total: 0 };
    const owners = await getTokenAccountOwners(holders.map((h) => h.address));
    const read = await readPoolState(coin.pool).catch(() => null);
    const baseVault = read ? poolStateOf(read.pool).baseVault.toBase58() : null;
    const rows = holders.map((h) => {
      const owner = owners.get(h.address) ?? h.address;
      return storage.holderRow(coin, owner, h.tokens, h.address === baseVault);
    });
    return { rows, total };
  } catch (err) {
    log(`holder lookup for ${coin.ca} failed: ${errorMessage(err)}`, "routes");
    return null;
  }
}

/** Unclaimed creator fees on a pool, or 0 when the RPC is unavailable. */
async function creatorClaimable(coin: Coin): Promise<number> {
  try {
    return (await getPoolFees(coin.pool)).creatorSol;
  } catch {
    return 0;
  }
}

async function buildCoinDetail(ca: string, viewerWallet: string | null): Promise<CoinDetail> {
  const coin = coinByCa(ca);
  const detail = storage.getCoinDetail(coin.ca, viewerWallet);
  if (!detail) throw new HttpError(404, "Coin not found");

  const [holders, balances, claimable] = await Promise.all([
    chainHolders(coin),
    viewerWallet ? getTokenBalances(viewerWallet, [coin.ca]).catch(() => new Map<string, number>()) : Promise.resolve(null),
    viewerWallet && viewerWallet === coin.creatorWallet ? creatorClaimable(coin) : Promise.resolve(0),
  ]);

  if (holders) {
    detail.topHolders = holders.rows;
    detail.holders = holders.total;
  }
  if (viewerWallet) {
    const tokens = balances?.get(coin.ca) ?? 0;
    const indexed: Holding = detail.myHolding ?? {
      wallet: viewerWallet,
      coinId: coin.id,
      tokens: 0,
      costBasisSol: 0,
      realizedPnlSol: 0,
    };
    detail.myHolding = tokens > 0 || indexed.costBasisSol > 0 || indexed.realizedPnlSol !== 0 ? { ...indexed, tokens } : null;
  }
  detail.creatorClaimableSol = claimable;
  return detail;
}

// ---------------------------------------------------------------------------
// External tokens (Jupiter)
// ---------------------------------------------------------------------------

/**
 * A mint the aggregator did not return is either unknown (404) or unreachable
 * (503) — the client shows a "not found" page for the first and a retry for the
 * second, so the two must not be conflated.
 */
function externalMiss(): [number, string] {
  return jupiter.jupiterStatus().available
    ? [404, "Token not found"]
    : [503, "Token discovery is unavailable right now. Please try again shortly."];
}

/**
 * The detail payload for any Solana mint. Every fetch also samples the price
 * into the in-memory ring buffer, which is where the chart's candles come from
 * (the free Jupiter tier has no OHLC endpoint).
 */
async function buildExternalDetail(rawId: string, viewerWallet: string | null): Promise<ExternalTokenDetail> {
  const parsed = parseTokenId(rawId);
  if (!parsed) throw new HttpError(404, "Token not found");
  if (parsed.chain !== "solana") return buildEvmDetail(parsed.chain, parsed.address);
  const mint = parsed.address;
  const found = await jupiter.getToken(mint);
  if (!found) throw new HttpError(...externalMiss());

  jupiter.recordPrice(mint, found.token.priceUsd);
  // Real OHLCV for the token's deepest pool. The aggregator does not always name
  // a pool, so fall back to asking the chart source which pool it charts, and to
  // the sampled ring buffer when neither knows one.
  let poolId = found.extras.pool?.id ?? null;
  let charted = poolId ? await markets.getCandles("solana", poolId) : [];
  if (charted.length === 0) {
    const viaMarkets = await markets.getToken("solana", mint);
    poolId = viaMarkets?.pool?.address ?? poolId;
    if (viaMarkets?.pool?.address) charted = await markets.getCandles("solana", viaMarkets.pool.address);
  }
  const balances = viewerWallet
    ? await getTokenBalances(viewerWallet, [mint]).catch(() => new Map<string, number>())
    : null;
  const { extras } = found;
  return {
    ...found.token,
    candles: charted.length > 0 ? charted : jupiter.candlesFor(mint),
    supply: extras.supply,
    organicScore: extras.organicScore,
    buys24h: extras.buys24h,
    sells24h: extras.sells24h,
    audit: extras.audit,
    links: extras.links,
    pool: extras.pool,
    myTokens: balances?.get(mint) ?? 0,
    explorerUrl: explorerUrl("token", mint),
    jupiterUrl: jupiter.jupiterSwapUrl(mint),
  };
}

/**
 * A token on a chain Next does not trade on yet: real numbers and real candles
 * from its deepest pool, no quote path, and `tradable: false` so the UI offers
 * the DEX instead of a Buy button it could not honour.
 */
async function buildEvmDetail(chain: Chain, address: string): Promise<ExternalTokenDetail> {
  const found = await markets.getToken(chain, address);
  if (!found) throw new HttpError(...externalMiss());
  const candles = found.pool ? await markets.getCandles(chain, found.pool.address) : [];
  const supply = found.token.priceUsd > 0 ? found.token.marketCapUsd / found.token.priceUsd : 0;
  return {
    ...found.token,
    candles,
    supply,
    organicScore: 0,
    buys24h: 0,
    sells24h: 0,
    audit: { mintAuthorityDisabled: null, freezeAuthorityDisabled: null, topHoldersPercent: null },
    links: { website: null, twitter: null, telegram: null },
    pool: found.pool ? { id: found.pool.address, dex: found.pool.dex, createdAt: null } : null,
    myTokens: 0,
    explorerUrl: chainExplorerUrl(chain, address),
    jupiterUrl: `https://www.geckoterminal.com/${chain === "ethereum" ? "eth" : chain}/tokens/${address}`,
  };
}

/** Block explorer for a contract on each supported chain. */
function chainExplorerUrl(chain: Chain, address: string): string {
  switch (chain) {
    case "ethereum":
      return `https://etherscan.io/token/${address}`;
    case "base":
      return `https://basescan.org/token/${address}`;
    case "bsc":
      return `https://bscscan.com/token/${address}`;
    case "monad":
      return `https://monadexplorer.com/token/${address}`;
    case "hyperliquid":
      return `https://hyperevmscan.io/token/${address}`;
    case "robinhood":
      return `https://explorer.robinhood.com/token/${address}`;
    default:
      return explorerUrl("token", address);
  }
}

/** `?chain=` → the chains to read, defaulting to every one we list. */
function requestedChains(raw: string | undefined): Chain[] {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "all") return CHAINS;
  const wanted = value
    .split(",")
    .map((c) => c.trim())
    .filter((c): c is Chain => (CHAINS as string[]).includes(c));
  return wanted.length > 0 ? wanted : CHAINS;
}

/**
 * Round-robins the per-chain lists so one busy chain cannot fill the whole feed
 * before another gets a row.
 */
function interleave(lists: ExternalToken[][]): ExternalToken[] {
  const out: ExternalToken[] = [];
  const longest = lists.reduce((max, l) => Math.max(max, l.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item) out.push(item);
    }
  }
  return out;
}

/**
 * Prices one side of an external trade. SOL is always the quote side: buying is
 * SOL → mint, selling is mint → SOL. Returns both the API-shaped quote and the
 * raw route, because Jupiter's swap endpoint wants its own quote object back
 * verbatim.
 */
async function routeExternalTrade(input: {
  mint: string;
  side: "buy" | "sell";
  amount: number;
  slippageBps: number;
}): Promise<{ quote: ReturnType<typeof jupiter.toExternalTradeQuote>; route: jupiter.JupQuote; token: ExternalToken }> {
  const found = await jupiter.getToken(input.mint);
  if (!found) throw new HttpError(...externalMiss());

  const buy = input.side === "buy";
  const amount = jupiter.toBaseUnits(input.amount, buy ? jupiter.SOL_DECIMALS : found.token.decimals);
  if (amount === "0") throw new HttpError(400, "Amount is too small");

  const route = await jupiter.getQuote({
    inputMint: buy ? jupiter.SOL_MINT : input.mint,
    outputMint: buy ? input.mint : jupiter.SOL_MINT,
    amount,
    slippageBps: input.slippageBps,
  });
  if (!route) throw new HttpError(502, "No route available for this trade right now");

  return {
    route,
    token: found.token,
    quote: jupiter.toExternalTradeQuote({
      side: input.side,
      quote: route,
      decimals: found.token.decimals,
      priceUsd: found.token.priceUsd,
      supply: found.extras.supply,
      solUsd: getSolUsd(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);
  wss = setupRealtime(httpServer);
  indexer.setBroadcaster((event, payload) => broadcast(event, payload as Record<string, unknown>));

  app.use(cookieParser());

  // Uploaded images are immutable-ish (coin logos and comment images never change; avatars
  // carry a cache-busting query), so a long browser cache is safe.
  app.use(
    "/uploads",
    express.static(UPLOADS_ROOT, { maxAge: "7d", index: false, dotfiles: "ignore", fallthrough: false }),
  );

  // Attach the signed-in user (if any) to every API request. API responses are
  // per-user and change constantly, so never let browsers cache them.
  app.use(
    "/api",
    wrap(async (req, res, next) => {
      res.set("Cache-Control", "no-store");
      const user = await getUserFromRequest(req);
      req.user = user ?? undefined;
      next();
    }),
  );

  // ---- Images -------------------------------------------------------------

  // Token icons live on IPFS gateways and hosts that refuse hot-linking; serving
  // them from our own origin (cached) is what makes every icon in a list render.
  app.get("/api/img", wrap(imageProxy));

  // ---- Config -------------------------------------------------------------

  app.get("/api/config", (_req, res) => {
    const appConfig: AppConfig = {
      appName: config.appName,
      googleClientId: config.google.clientId,
      appleClientId: config.apple.clientId,
      instantEmailLogin: config.instantEmailLogin,
      magicLinkDevMode,
      chain: clusterInfo(),
      solUsd: getSolUsd(),
      swapFee: SWAP_FEE,
      creatorFeeShare: CREATOR_FEE_SHARE,
      totalSupply: TOTAL_SUPPLY,
      launchMcapUsd: LAUNCH_MCAP_USD,
      graduationMcapUsd: GRADUATION_MCAP_USD,
      vanityAvailable: vanity.count(),
      launchEnabled,
    };
    res.json(appConfig);
  });

  // ---- Auth ---------------------------------------------------------------

  // Pre-launch sign-in: email only, no verification. Disabled with INSTANT_EMAIL_LOGIN=0.
  app.post(
    "/api/auth/email",
    wrap(async (req, res) => {
      if (!config.instantEmailLogin) throw new HttpError(404, "Instant email sign-in is disabled");
      const { email } = magicLinkRequestSchema.parse(req.body);
      const ipKey = `ip:${clientIp(req)}`;
      magicLinkLimiter.check(ipKey, res, "Too many sign-in attempts. Please wait a few minutes and try again.");
      magicLinkLimiter.record(ipKey);
      const { user } = storage.findOrCreateUser(email, "email");
      await setSessionCookie(res, user.id);
      res.json(storage.toSafeUser(user));
    }),
  );

  app.post(
    "/api/auth/magic",
    wrap(async (req, res) => {
      const { email } = magicLinkRequestSchema.parse(req.body);
      const ipKey = `ip:${clientIp(req)}`;
      const emailKey = `email:${email}`;
      if (magicLinkLimiter.isLimited(ipKey) || magicLinkLimiter.isLimited(emailKey)) {
        res.set("Retry-After", String(Math.ceil(MAGIC_LINK_WINDOW_MS / 1000)));
        throw new HttpError(429, "Too many sign-in links requested. Please wait a few minutes and try again.");
      }
      magicLinkLimiter.record(ipKey);
      magicLinkLimiter.record(emailKey);

      const token = createMagicToken(email);
      const link = buildMagicLink(token);
      try {
        await sendMagicLink({ to: email, link });
      } catch (err) {
        log(`failed to send magic link: ${errorMessage(err)}`, "auth");
        throw new HttpError(502, "We couldn't send the sign-in email right now. Please try again shortly.");
      }
      // Never reveal whether the address belongs to an account.
      res.json(magicLinkDevMode ? { ok: true, devLink: link } : { ok: true });
    }),
  );

  app.get(
    "/api/auth/verify",
    wrap(async (req, res) => {
      const token = queryString(req.query.token);
      const email = token ? consumeMagicToken(token) : null;
      if (!email) {
        res.redirect(302, "/?auth_error=invalid_link");
        return;
      }
      try {
        const { user } = storage.findOrCreateUser(email, "email");
        await setSessionCookie(res, user.id);
      } catch (err) {
        log(`magic link sign-in failed for a verified email: ${errorMessage(err)}`, "auth");
        res.redirect(302, "/?auth_error=signin_failed");
        return;
      }
      res.redirect(302, "/?welcome=1");
    }),
  );

  const idTokenSignIn = (
    provider: Exclude<AuthProvider, "email" | "wallet">,
    verify: (credential: string) => Promise<{ email: string; name?: string }>,
  ) =>
    wrap(async (req, res) => {
      const { credential } = idTokenSchema.parse(req.body);
      const identity = await verify(credential);
      const { user } = storage.findOrCreateUser(identity.email, provider, identity.name);
      await setSessionCookie(res, user.id);
      res.json(storage.toSafeUser(user));
    });

  app.post("/api/auth/google", idTokenSignIn("google", verifyGoogleIdToken));
  app.post("/api/auth/apple", idTokenSignIn("apple", verifyAppleIdToken));

  // Sign-In-With-Solana: challenge, then signed challenge. See walletAuth.ts.
  app.get(
    "/api/auth/wallet/nonce",
    wrap((req, res) => {
      const ipKey = `ip:${clientIp(req)}`;
      walletNonceLimiter.check(ipKey, res, "Too many sign-in attempts. Please wait a few minutes and try again.");
      walletNonceLimiter.record(ipKey);
      res.json(issueWalletNonce(queryString(req.query.address)));
    }),
  );

  app.post(
    "/api/auth/wallet",
    wrap(async (req, res) => {
      const ipKey = `ip:${clientIp(req)}`;
      walletLoginLimiter.check(ipKey, res, "Too many sign-in attempts. Please wait a few minutes and try again.");
      walletLoginLimiter.record(ipKey);
      const input = walletLoginSchema.parse(req.body);
      const address = verifyWalletLogin(input);
      const { user } = storage.findOrCreateWalletUser(address);
      await setSessionCookie(res, user.id);
      res.json(storage.toSafeUser(user));
    }),
  );

  app.post("/api/auth/logout", (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ---- Me -----------------------------------------------------------------

  app.get(
    "/api/me",
    requireAuth,
    wrap((req, res) => {
      res.json(storage.toSafeUser(currentUser(req)));
    }),
  );

  app.patch(
    "/api/me",
    requireAuth,
    wrap((req, res) => {
      const input = updateProfileSchema.parse(req.body);
      const user = storage.updateProfile(currentUser(req).id, input);
      res.json(storage.toSafeUser(user));
    }),
  );

  app.post(
    "/api/me/avatar",
    requireAuth,
    wrap(async (req, res) => {
      const { image } = avatarSchema.parse(req.body);
      const me = currentUser(req);
      // One file per user, overwritten on each upload; the query string defeats the 7-day cache.
      const url = await saveImage(image, "avatars", String(me.id), 128);
      const user = storage.setAvatar(me.id, `${url}?v=${Date.now().toString(36)}`);
      res.json(storage.toSafeUser(user));
    }),
  );

  app.post(
    "/api/me/banner",
    requireAuth,
    wrap(async (req, res) => {
      const { image } = avatarSchema.parse(req.body);
      const me = currentUser(req);
      // One file per user, overwritten on each upload; the query string defeats the cache.
      const url = await saveImage(image, "banners", String(me.id), 1200);
      const user = storage.setBanner(me.id, `${url}?v=${Date.now().toString(36)}`);
      res.json(storage.toSafeUser(user));
    }),
  );

  /** Links a Solana wallet to an email/Google/Apple account (same signed challenge). */
  app.post(
    "/api/me/wallet",
    requireAuth,
    wrap((req, res) => {
      const ipKey = `ip:${clientIp(req)}`;
      walletLoginLimiter.check(ipKey, res, "Too many attempts. Please wait a few minutes and try again.");
      walletLoginLimiter.record(ipKey);
      const input = walletLoginSchema.parse(req.body);
      const address = verifyWalletLogin(input);
      const user = storage.linkWallet(currentUser(req).id, address);
      res.json(storage.toSafeUser(user));
    }),
  );

  // ---- Aggregates ---------------------------------------------------------

  app.get(
    "/api/stats",
    wrap((_req, res) => {
      res.json(storage.getStats());
    }),
  );

  app.get(
    "/api/activity",
    wrap((req, res) => {
      const items: ActivityItem[] = storage.getActivity(parseLimit(req.query.limit, 60, 200));
      res.json(items);
    }),
  );

  // ---- Coins --------------------------------------------------------------

  app.get(
    "/api/coins",
    wrap((req, res) => {
      const filters = coinListQuerySchema.parse({
        sort: queryString(req.query.sort),
        search: queryString(req.query.q) ?? queryString(req.query.search),
      });
      res.json(storage.listCoins({ ...filters, limit: parseLimit(req.query.limit, 60, 200) }));
    }),
  );

  /**
   * Step 1 of a launch: store the image and the metadata JSON and reserve a mint.
   * Nothing touches the chain yet — the reservation expires after 15 minutes.
   */
  app.post(
    "/api/coins/prepare",
    requireAuth,
    wrap(async (req, res) => {
      if (!launchEnabled) throw new HttpError(503, "Launching is not configured on this server (DBC_CONFIG)");
      const { user, wallet } = currentWallet(req);
      const userKey = `user:${user.id}`;
      coinCreateLimiter.check(userKey, res, "You can launch at most 5 coins per hour. Please try again later.");
      const input = prepareCoinSchema.parse(req.body);
      sweepPrepared();

      const reservation = await vanity.reserve();
      const mint = reservation.keypair.publicKey.toBase58();
      let imageUrl: string;
      try {
        imageUrl = await saveImage(input.image, "coins", mint, 512);
      } catch (err) {
        await vanity.release(reservation.id);
        throw err;
      }

      const uri = metadataUri(mint);
      const meta = buildTokenMetadata({
        name: input.name,
        ticker: input.ticker,
        description: input.description,
        imageUrl,
        website: input.website,
        twitter: input.twitter,
        telegram: input.telegram,
      });
      try {
        await saveTokenMetadata(mint, meta);
      } catch (err) {
        void deleteImage(imageUrl);
        await vanity.release(reservation.id);
        throw err;
      }

      prepared.set(reservation.id, {
        id: reservation.id,
        userId: user.id,
        mint,
        vanity: reservation.vanity,
        name: input.name,
        ticker: input.ticker,
        description: input.description,
        imageUrl,
        metadataUri: uri,
        website: input.website || null,
        twitter: input.twitter || null,
        telegram: input.telegram || null,
        expiresAt: reservation.expiresAt,
      });
      coinCreateLimiter.record(userKey);
      log(`${wallet} prepared ${input.ticker} as ${mint}${reservation.vanity ? " (vanity)" : ""}`, "coins");

      const response: PreparedCoin = {
        id: reservation.id,
        mint,
        vanity: reservation.vanity,
        metadataUri: uri,
        imageUrl,
        expiresAt: new Date(reservation.expiresAt).toISOString(),
      };
      res.status(201).json(response);
    }),
  );

  /** Step 2: the unsigned create-pool transaction (mint keypair already co-signed). */
  app.post(
    "/api/coins/create-tx",
    requireAuth,
    wrap(async (req, res) => {
      if (!launchEnabled) throw new HttpError(503, "Launching is not configured on this server (DBC_CONFIG)");
      const { user, wallet } = currentWallet(req);
      txLimiter.check(`user:${user.id}`, res, "Too many transactions. Please slow down.");
      txLimiter.record(`user:${user.id}`);
      const input = createTxSchema.parse(req.body);
      if (input.wallet !== wallet) throw new HttpError(403, "That wallet is not linked to your account");

      sweepPrepared();
      const entry = prepared.get(input.prepareId);
      const reservation = vanity.get(input.prepareId);
      if (!entry || !reservation) throw new HttpError(410, "This launch expired. Please upload the image again.");
      if (entry.userId !== user.id) throw new HttpError(403, "This launch belongs to another account");

      // There is no pool to quote against yet: the creator is the very first buyer
      // and gets the deterministic starting price, so one base unit is enough of a
      // floor to keep the instruction happy.
      const minOut = input.initialBuySol > 0 ? 1 / 10 ** TOKEN_DECIMALS : 0;
      const built = await buildCreateTx({
        payer: new PublicKey(wallet),
        poolCreator: new PublicKey(wallet),
        baseMint: reservation.keypair,
        name: entry.name,
        symbol: entry.ticker,
        uri: entry.metadataUri,
        firstBuySol: input.initialBuySol,
        minOut,
      });

      // The mint is spent even if the user never signs: reusing it after a
      // creation transaction may still land would be far worse.
      vanity.consume(input.prepareId);
      prepared.delete(input.prepareId);

      const response: UnsignedTx = { tx: built.tx, lastValidBlockHeight: built.lastValidBlockHeight, mint: entry.mint };
      res.json(response);
    }),
  );

  /** The Metaplex off-chain metadata for a mint we launched. */
  app.get(
    "/api/meta/:file",
    wrap(async (req, res) => {
      const mint = req.params.file.replace(/\.json$/, "");
      if (!isMint(mint)) throw new HttpError(404, "Not found");
      const meta = await readTokenMetadata(mint);
      if (!meta) throw new HttpError(404, "Not found");
      res.set("Cache-Control", "public, max-age=300");
      res.json(meta);
    }),
  );

  app.get(
    "/api/coins/:ca",
    wrap(async (req, res) => {
      res.json(await buildCoinDetail(req.params.ca, req.user?.walletAddress ?? null));
    }),
  );

  app.get(
    "/api/coins/:ca/candles",
    wrap((req, res) => {
      res.json(storage.getCandles(coinByCa(req.params.ca).id));
    }),
  );

  app.get(
    "/api/coins/:ca/trades",
    wrap((req, res) => {
      const coin = coinByCa(req.params.ca);
      res.json(storage.getCoinTrades(coin.id, parseLimit(req.query.limit, 100, 500)));
    }),
  );

  app.post(
    "/api/coins/:ca/quote",
    wrap(async (req, res) => {
      const coin = coinByCa(req.params.ca);
      const input = quoteSchema.parse(req.body);
      if (coin.curve.migrated) throw new HttpError(400, "This coin has graduated and now trades on Meteora");
      try {
        res.json(await quoteSwap(coin.pool, input.side, input.amount, input.slippageBps));
      } catch (err) {
        throw new HttpError(400, errorMessage(err));
      }
    }),
  );

  /** The unsigned swap transaction for the connected wallet. */
  app.post(
    "/api/coins/:ca/swap-tx",
    requireAuth,
    wrap(async (req, res) => {
      const { user, wallet } = currentWallet(req);
      txLimiter.check(`user:${user.id}`, res, "Too many transactions. Please slow down.");
      txLimiter.record(`user:${user.id}`);
      const coin = coinByCa(req.params.ca);
      const input = swapTxSchema.parse(req.body);
      if (input.wallet !== wallet) throw new HttpError(403, "That wallet is not linked to your account");
      if (coin.curve.migrated) throw new HttpError(400, "This coin has graduated and now trades on Meteora");

      const quote = await quoteSwap(coin.pool, input.side, input.amount, input.slippageBps).catch((err: unknown) => {
        throw new HttpError(400, errorMessage(err));
      });
      const built = await buildSwapTx({
        owner: new PublicKey(wallet),
        pool: new PublicKey(coin.pool),
        side: input.side,
        amount: input.amount,
        minOut: quote.minOut,
      });
      const response: UnsignedTx = { tx: built.tx, lastValidBlockHeight: built.lastValidBlockHeight, quote };
      res.json(response);
    }),
  );

  /** Claim trading fees: the coin's creator, or the treasury for the platform share. */
  app.post(
    "/api/coins/:ca/claim-tx",
    requireAuth,
    wrap(async (req, res) => {
      const { wallet } = currentWallet(req);
      const coin = coinByCa(req.params.ca);
      const treasury = treasuryPubkey?.toBase58() ?? null;
      const pool = new PublicKey(coin.pool);
      let built;
      if (wallet === coin.creatorWallet) {
        built = await buildClaimCreatorFeeTx(new PublicKey(wallet), pool);
      } else if (treasury && wallet === treasury) {
        built = await buildClaimPartnerFeeTx(new PublicKey(wallet), pool);
      } else {
        throw new HttpError(403, "Only the creator can claim these fees");
      }
      const response: UnsignedTx = { tx: built.tx, lastValidBlockHeight: built.lastValidBlockHeight };
      res.json(response);
    }),
  );

  /**
   * Relays a signed transaction, waits for confirmation and indexes it, so the
   * response already carries the resulting trade or the freshly created coin.
   */
  app.post(
    "/api/tx/send",
    requireAuth,
    wrap(async (req, res) => {
      const { user } = currentWallet(req);
      txLimiter.check(`user:${user.id}`, res, "Too many transactions. Please slow down.");
      txLimiter.record(`user:${user.id}`);
      const input = sendTxSchema.parse(req.body);

      let signature: string;
      try {
        signature = await sendSignedTx(input.tx);
      } catch (err) {
        throw new HttpError(400, errorMessage(err));
      }

      const response: SentTx = { signature, explorerUrl: explorerUrl("tx", signature), confirmed: true };

      if (input.kind === "create" && input.ca) {
        const coin = await waitForCoin(input.ca);
        if (coin) {
          response.coin = storage.summarize(coin);
          broadcast("coin:created", { coin: response.coin });
        }
      } else if (input.kind === "swap") {
        const trade = await indexer.indexSignature(signature).catch(() => null);
        if (trade) response.trade = trade;
      }
      // "jupswap" (an external token routed through Jupiter) and "claim" are
      // relayed and confirmed above but never indexed: neither is a trade
      // against one of our bonding curves.

      res.status(201).json(response);
    }),
  );

  // ---- External tokens (any Solana memecoin, routed through Jupiter) -------

  /**
   * Discovery feed. `q` searches by mint, symbol or name; otherwise one of the
   * curated lists is returned. Always answers with an array: when Jupiter is
   * unreachable that array is empty and the UI shows its "unavailable" state
   * rather than an error page.
   */
  app.get(
    "/api/tokens",
    wrap(async (req, res) => {
      const limit = parseLimit(req.query.limit, 50, 100);
      const q = (queryString(req.query.q) ?? queryString(req.query.search) ?? "").trim();
      const list = tokenListQuerySchema.parse(queryString(req.query.list));
      const chains = requestedChains(queryString(req.query.chain));

      // Solana comes from Jupiter, every other chain from GeckoTerminal; both
      // degrade to an empty list rather than failing the request.
      const perChain = await Promise.all(
        chains.map(async (chain): Promise<ExternalToken[]> => {
          if (chain === "solana") {
            return q ? jupiter.searchTokens(q, limit) : jupiter.listTokens(list, limit);
          }
          return q ? markets.searchTokens(chain, q, limit) : markets.listTokens(chain, list, limit);
        }),
      );
      res.json(interleave(perChain).slice(0, limit));
    }),
  );

  app.get(
    "/api/tokens/:mint",
    wrap(async (req, res) => {
      res.json(await buildExternalDetail(req.params.mint, req.user?.walletAddress ?? null));
    }),
  );

  /** Same as above for a token id that carries its chain ("base:0x…"). */
  app.get(
    "/api/tokens/:chain/:address",
    wrap(async (req, res) => {
      res.json(await buildExternalDetail(`${req.params.chain}:${req.params.address}`, req.user?.walletAddress ?? null));
    }),
  );

  app.post(
    "/api/tokens/:mint/quote",
    wrap(async (req, res) => {
      const ipKey = `ip:${clientIp(req)}`;
      externalQuoteLimiter.check(ipKey, res, "Too many quotes. Please slow down.");
      externalQuoteLimiter.record(ipKey);
      const input = externalQuoteSchema.parse({ ...req.body, mint: req.params.mint });
      res.json((await routeExternalTrade(input)).quote);
    }),
  );

  /** The unsigned Jupiter swap (a base64 VersionedTransaction) for the connected wallet. */
  app.post(
    "/api/tokens/:mint/swap-tx",
    requireAuth,
    wrap(async (req, res) => {
      const { user, wallet } = currentWallet(req);
      txLimiter.check(`user:${user.id}`, res, "Too many transactions. Please slow down.");
      txLimiter.record(`user:${user.id}`);
      const input = externalSwapTxSchema.parse({ ...req.body, mint: req.params.mint });
      if (input.wallet !== wallet) throw new HttpError(403, "That wallet is not linked to your account");

      const { quote, route } = await routeExternalTrade(input);
      const built = await jupiter.buildSwapTx({ quote: route, userPublicKey: wallet });
      if (!built) throw new HttpError(502, "Jupiter could not build this swap right now. Please try again.");
      const response: UnsignedTx = {
        tx: built.swapTransaction,
        lastValidBlockHeight: built.lastValidBlockHeight,
        quote,
      };
      res.json(response);
    }),
  );

  /**
   * What each upstream is doing right now. Handy when a list is empty and the
   * question is "unreachable, or genuinely nothing?".
   */
  app.get("/api/markets/status", (_req, res) => {
    res.json({
      jupiter: jupiter.jupiterStatus(),
      geckoterminal: markets.marketsStatus(),
      hyperliquid: hyperliquid.hyperliquidStatus(),
    });
  });

  // ---- Perps (Hyperliquid) -------------------------------------------------

  app.get(
    "/api/perps",
    wrap(async (req, res) => {
      res.json(await hyperliquid.listPerps(parseLimit(req.query.limit, 100, 200)));
    }),
  );

  /** One perp market with its real candles, for the detail page. */
  app.get(
    "/api/perps/:symbol",
    wrap(async (req, res) => {
      const symbol = req.params.symbol.trim().slice(0, 32);
      const market = await hyperliquid.getPerp(symbol);
      if (!market) throw new HttpError(404, "Market not found");
      const candles = await hyperliquid.getCandles(market.symbol, "1m", 500);
      res.json({ ...market, candles });
    }),
  );

  // ---- Comments -----------------------------------------------------------

  app.get(
    "/api/coins/:ca/comments",
    wrap((req, res) => {
      res.json(storage.listComments(coinByCa(req.params.ca).id));
    }),
  );

  app.post(
    "/api/coins/:ca/comments",
    requireAuth,
    wrap(async (req, res) => {
      const me = currentUser(req);
      const userKey = `user:${me.id}`;
      commentLimiter.check(userKey, res, "You're commenting too fast. Please wait a minute.");
      const coin = coinByCa(req.params.ca);
      const isThesis = (req.body as { kind?: unknown } | null)?.kind === "thesis";
      const { body, image } = isThesis ? thesisSchema.parse(req.body) : commentSchema.parse(req.body);

      if (isThesis) {
        // A thesis argues for a position, so it needs one — and only one every 10 minutes.
        const wallet = me.walletAddress;
        const holding = wallet ? storage.findHolding(wallet, coin.id) : undefined;
        if (!holding || holding.tokens <= 0) {
          throw new HttpError(403, `You need an open ${coin.ticker} position to publish a thesis.`);
        }
        const waitMs = storage.lastThesisAt(coin.id, me.id) + THESIS_COOLDOWN_MS - Date.now();
        if (waitMs > 0) {
          throw new HttpError(429, `You can publish another thesis in ${Math.ceil(waitMs / 60_000)} min.`);
        }
      }

      const imageUrl = image ? await saveImage(image, "comments", `${coin.id}-${Date.now().toString(36)}`, 800) : undefined;
      let comment: CommentView;
      try {
        comment = storage.addComment(coin.id, me.id, body, imageUrl, isThesis ? "thesis" : "comment");
      } catch (err) {
        if (imageUrl) void deleteImage(imageUrl);
        throw err;
      }
      commentLimiter.record(userKey);

      broadcast("comment", { comment, ca: coin.ca });
      res.status(201).json(comment);
    }),
  );

  app.post(
    "/api/comments/:id/like",
    requireAuth,
    wrap((req, res) => {
      const id = parseId(req.params.id);
      const comment = storage.toggleLike(id, currentUser(req).id);
      broadcast("comment", { comment, ca: storage.getCommentCoinCa(comment.id) ?? null });
      res.json(comment);
    }),
  );

  // ---- Portfolio & wallet -------------------------------------------------

  app.get(
    "/api/portfolio",
    requireAuth,
    wrap(async (req, res) => {
      const user = currentUser(req);
      const wallet = user.walletAddress;
      const portfolio: Portfolio = storage.getPortfolio(wallet);
      if (wallet) {
        const [balanceSol, balances] = await Promise.all([
          getSolBalance(wallet).catch(() => 0),
          getTokenBalances(
            wallet,
            portfolio.holdings.map((h) => h.coin.ca),
          ).catch(() => new Map<string, number>()),
        ]);
        portfolio.balanceSol = balanceSol;
        // The chain is authoritative for what the wallet actually holds.
        let holdingsValueSol = 0;
        let unrealizedPnlSol = 0;
        portfolio.holdings = portfolio.holdings
          .map((h) => {
            const tokens = balances.get(h.coin.ca) ?? h.tokens;
            const valueSol = tokens * h.coin.priceSol;
            const pnl = valueSol - h.costBasisSol;
            holdingsValueSol += valueSol;
            unrealizedPnlSol += pnl;
            return { ...h, tokens, valueSol, unrealizedPnlSol: pnl };
          })
          .filter((h) => h.tokens > 0)
          .sort((a, b) => b.valueSol - a.valueSol);
        portfolio.holdingsValueSol = holdingsValueSol;
        portfolio.unrealizedPnlSol = unrealizedPnlSol;
        portfolio.totalValueSol = balanceSol + holdingsValueSol;
        portfolio.creatorClaimableSol = await claimableForCoins(portfolio.createdCoins);
      }
      res.json(portfolio);
    }),
  );

  app.get(
    "/api/wallet",
    wrap(async (req, res) => {
      const wallet = req.user?.walletAddress ?? null;
      const view: WalletView = {
        wallet,
        balanceSol: wallet ? await getSolBalance(wallet).catch(() => 0) : 0,
        solUsd: getSolUsd(),
        chain: clusterInfo(),
      };
      res.json(view);
    }),
  );

  // ---- Public profiles ----------------------------------------------------

  app.get(
    "/api/users/:username",
    wrap((req, res) => {
      const profile = storage.getPublicProfile(req.params.username, req.user?.walletAddress ?? null);
      if (!profile) throw new HttpError(404, "User not found");
      res.json(profile);
    }),
  );

  // ---- Follows, leaderboard & feed -----------------------------------------
  //
  // Anyone who has traded is followable, whether or not they have an account —
  // follows are keyed by wallet address, not by user id.

  const leaderboardRangeSchema = z.enum(["24h", "7d", "30d", "all"]).catch("all");
  const feedScopeSchema = z.enum(["global", "following"]).catch("global");

  app.post(
    "/api/follow",
    requireAuth,
    wrap((req, res) => {
      const { wallet } = currentWallet(req);
      const { wallet: target } = followSchema.parse(req.body);
      storage.follow(wallet, target);
      res.status(201).json({ isFollowing: true });
    }),
  );

  app.delete(
    "/api/follow/:wallet",
    requireAuth,
    wrap((req, res) => {
      const { wallet } = currentWallet(req);
      const target = req.params.wallet;
      if (!SOLANA_ADDRESS_RE.test(target)) throw new HttpError(400, "Invalid wallet address");
      storage.unfollow(wallet, target);
      res.json({ isFollowing: false });
    }),
  );

  app.get(
    "/api/traders",
    wrap((req, res) => {
      const range = leaderboardRangeSchema.parse(queryString(req.query.range));
      const followingOnly = queryString(req.query.scope) === "following";
      const onlyWallets = followingOnly ? new Set(storage.followingWallets(currentWallet(req).wallet)) : null;
      const rows: TraderRank[] = storage.getTraders(
        range,
        parseLimit(req.query.limit, 100, 200),
        req.user?.walletAddress ?? null,
        onlyWallets,
      );
      res.json(rows);
    }),
  );

  /** Where the signed-in wallet sits on the leaderboard (the "Your rank" card). */
  app.get(
    "/api/traders/me",
    requireAuth,
    wrap((req, res) => {
      const { wallet } = currentWallet(req);
      const range = leaderboardRangeSchema.parse(queryString(req.query.range));
      const rank: MyRank = storage.getTraderRankFor(wallet, range);
      res.json(rank);
    }),
  );

  app.get(
    "/api/feed",
    wrap((req, res) => {
      const scope = feedScopeSchema.parse(queryString(req.query.scope));
      const items: FeedEntry[] = storage.getFeed(scope, req.user?.walletAddress ?? null, parseLimit(req.query.limit, 60, 200));
      res.json(items);
    }),
  );

  // ---- Admin --------------------------------------------------------------

  app.get(
    "/api/admin/overview",
    requireAdmin,
    wrap(async (_req, res) => {
      const coins = storage.listCoins({ sort: "volume", limit: 25 });
      const claimable: AdminOverview["claimable"] = [];
      for (const summary of coins) {
        const coin = storage.findCoinByCa(summary.ca);
        if (!coin || !coin.pool) continue;
        try {
          const fees = await getPoolFees(coin.pool);
          if (fees.partnerSol <= 0 && fees.creatorSol <= 0) continue;
          claimable.push({
            coin: { id: coin.id, ca: coin.ca, name: coin.name, ticker: coin.ticker, imageUrl: coin.imageUrl },
            partnerSol: fees.partnerSol,
            creatorSol: fees.creatorSol,
          });
        } catch {
          // RPC hiccup: skip this pool rather than failing the whole page.
        }
      }
      const overview: AdminOverview = {
        stats: storage.getStats(),
        vanityAvailable: vanity.count(),
        vanityUsed: vanity.usedCount(),
        claimable,
        indexer: indexer.status(),
      };
      res.json(overview);
    }),
  );

  app.get(
    "/api/admin/users",
    requireAdmin,
    wrap((req, res) => {
      res.json(storage.listUsers(queryString(req.query.search) ?? queryString(req.query.q) ?? "", parseLimit(req.query.limit, 100, 500)));
    }),
  );

  /** The grinder pushes pre-mined "…next" mints here (token auth, no session). */
  app.post(
    "/api/admin/vanity",
    wrap(async (req, res) => {
      const token = req.header("x-admin-token");
      if (!config.adminApiToken) throw new HttpError(503, "ADMIN_API_TOKEN is not configured");
      if (token !== config.adminApiToken) throw new HttpError(401, "Invalid admin token");
      const { keypairs } = vanityUploadSchema.parse(req.body);
      const result = await vanity.add(keypairs);
      res.json({ added: result.added, available: result.available });
    }),
  );

  /** Treasury claim of the platform fee share on one pool. */
  app.post(
    "/api/admin/claim-tx",
    requireAuth,
    wrap(async (req, res) => {
      const { wallet } = currentWallet(req);
      const treasury = treasuryPubkey?.toBase58() ?? null;
      if (!treasury) throw new HttpError(503, "TREASURY_WALLET is not configured");
      if (wallet !== treasury) throw new HttpError(403, "Only the treasury wallet can claim platform fees");
      const { ca } = claimSchema.parse(req.body);
      const coin = coinByCa(ca);
      const built = await buildClaimPartnerFeeTx(new PublicKey(wallet), new PublicKey(coin.pool));
      const response: UnsignedTx = { tx: built.tx, lastValidBlockHeight: built.lastValidBlockHeight };
      res.json(response);
    }),
  );

  // ---- Fallbacks ----------------------------------------------------------

  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ message: "Not found" });
  });

  app.use("/api", (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ message: fromZodError(err).message });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ message: err.message });
      return;
    }
    const e = (err ?? {}) as { status?: unknown; statusCode?: unknown; type?: unknown; message?: unknown };
    // body-parser errors
    if (e.type === "entity.parse.failed") {
      res.status(400).json({ message: "Malformed JSON body" });
      return;
    }
    if (e.type === "entity.too.large") {
      res.status(413).json({ message: "Request body too large (images must be under 2 MB)" });
      return;
    }
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 0;
    if (status >= 400 && status < 500 && typeof e.message === "string") {
      res.status(status).json({ message: e.message });
      return;
    }
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    log(`${req.method} ${req.originalUrl} -> 500: ${detail}`, "error");
    res.status(500).json({ message: "Internal Server Error" });
  });

  return httpServer;
}

// ---------------------------------------------------------------------------
// Post-send helpers
// ---------------------------------------------------------------------------

/** Waits (briefly) for the indexer to pick up a pool that was just created. */
async function waitForCoin(mint: string, timeoutMs = 15_000): Promise<Coin | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const known = storage.findCoinByCa(mint);
    if (known) return known;
    const indexed = await indexer.indexPoolForMint(mint);
    if (indexed) return indexed;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Sum of the creator fees claimable across a set of coins (best effort). */
async function claimableForCoins(coins: CoinSummary[]): Promise<number> {
  let total = 0;
  for (const coin of coins.slice(0, 20)) {
    if (!coin.pool) continue;
    try {
      total += (await getPoolFees(coin.pool)).creatorSol;
    } catch {
      // ignore: a single unreachable pool must not break the portfolio
    }
  }
  return total;
}
