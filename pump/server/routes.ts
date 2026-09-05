import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { createServer, type IncomingMessage, type Server } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
// @ts-ignore -- @types/cookie-parser is not installed (run `npm i -D @types/cookie-parser`); the runtime package is.
import cookieParser from "cookie-parser";
import { nanoid } from "nanoid";
import { z, ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import {
  CREATOR_FEE_SHARE,
  GRADUATION_MCAP,
  SWAP_FEE,
  TOTAL_SUPPLY,
  adminCreditSchema,
  commentSchema,
  createCoinSchema,
  idTokenSchema,
  magicLinkRequestSchema,
  tradeSchema,
  updateProfileSchema,
  walletLoginSchema,
  withdrawSchema,
  type AppConfig,
  type AuthProvider,
  type CoinDetail,
  type CoinSummary,
  type CommentView,
  type Trade,
  type User,
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
import { isValidCa } from "./ca";
import { processWithdrawal, withdrawalsEnabled } from "./chain";
import { config } from "./config";
import { magicLinkDevMode, sendMagicLink } from "./email";
import { UPLOADS_ROOT, deleteImage, saveImage } from "./uploads";
import { log } from "./vite";
import { issueWalletNonce, verifyWalletLogin } from "./walletAuth";

// ---------------------------------------------------------------------------
// Realtime (WebSocket) fan-out
// ---------------------------------------------------------------------------

const WS_PATH = "/ws";
const WS_HEARTBEAT_MS = 30_000;

let wss: WebSocketServer | null = null;

/** Push `{ event, payload }` to every connected client. No-op until registerRoutes has run. */
export function broadcast(event: string, payload: unknown): void {
  if (!wss || wss.clients.size === 0) return;
  const message = JSON.stringify({ event, payload });
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

/** Positive integer route parameter, or 400. */
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

/** First string value of a query parameter (Express may hand us arrays or nested objects). */
function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/** Clamp a numeric query parameter into [1, max], falling back when absent or unparsable. */
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

/**
 * Coin detail records are indexed by CA in storage; the route parameter must look like
 * one before we even ask, so junk paths (and the SPA's own routes) are a cheap 404.
 */
function coinByCa(ca: string, viewerId?: number): CoinDetail {
  const coin = isValidCa(ca) ? storage.getCoinByCa(ca, viewerId) : undefined;
  if (!coin) throw new HttpError(404, "Coin not found");
  rememberCa(coin);
  return coin;
}

/** Strip the detail-only fields so realtime frames carry exactly a CoinSummary. */
function toSummary(coin: CoinDetail): CoinSummary {
  const { candles: _candles, recentTrades: _trades, commentsList: _comments, topHolders: _holders, myHolding: _mine, ...summary } = coin;
  return summary;
}

/**
 * Comments only know their coinId, but the client keys everything by CA. We remember every
 * id -> CA pair we see; the rare miss (like on a comment right after a restart) falls back to
 * scanning the coin list, which is small enough for a single-process deployment.
 */
const caByCoinId = new Map<number, string>();

function rememberCa(coin: Pick<CoinSummary, "id" | "ca">): void {
  caByCoinId.set(coin.id, coin.ca);
}

function coinCaById(coinId: number): string {
  const cached = caByCoinId.get(coinId);
  if (cached) return cached;
  const found = storage.listCoins({ sort: "new", limit: Number.MAX_SAFE_INTEGER }).find((c) => c.id === coinId);
  if (!found) throw new HttpError(404, "Coin not found");
  rememberCa(found);
  return found.ca;
}

// Query-string filters: `.catch(undefined)` makes unknown values act as "not provided"
// instead of failing the request.
const coinListQuerySchema = z.object({
  sort: z.enum(["new", "trending", "mcap", "volume", "graduated"]).optional().catch(undefined),
  search: z.string().trim().min(1).max(100).optional().catch(undefined),
});

const avatarSchema = z.object({
  image: z.string().regex(/^data:image\/(png|jpe?g|webp|gif);base64,/, "Upload an image").max(2_000_000),
});

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
const MAGIC_LINK_MAX_REQUESTS = 5;
const magicLinkLimiter = new RateLimiter(MAGIC_LINK_MAX_REQUESTS, MAGIC_LINK_WINDOW_MS);

/** Wallet challenges are cheap but each one is a Map entry; cap them per IP. */
const walletNonceLimiter = new RateLimiter(30, 10 * 60 * 1000);
const walletLoginLimiter = new RateLimiter(20, 15 * 60 * 1000);

/** Coin creation: 5 per user per hour. */
const coinCreateLimiter = new RateLimiter(5, 60 * 60 * 1000);
/** Comments: 20 per user per minute. */
const commentLimiter = new RateLimiter(20, 60 * 1000);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);
  wss = setupRealtime(httpServer);

  app.use(cookieParser());

  // Uploaded images are immutable-ish (coin logos and comment images never change; avatars
  // carry a cache-busting query), so a long browser cache is safe.
  app.use(
    "/uploads",
    express.static(UPLOADS_ROOT, {
      maxAge: "7d",
      index: false,
      dotfiles: "ignore",
      fallthrough: false,
    }),
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

  // ---- Config -------------------------------------------------------------

  app.get("/api/config", (_req, res) => {
    const appConfig: AppConfig = {
      appName: config.appName,
      googleClientId: config.google.clientId,
      appleClientId: config.apple.clientId,
      walletConnectProjectId: config.walletConnectProjectId,
      instantEmailLogin: config.instantEmailLogin,
      magicLinkDevMode,
      chain: config.chain,
      depositsEnabled: config.depositsEnabled,
      withdrawalsEnabled,
      swapFee: SWAP_FEE,
      creatorFeeShare: CREATOR_FEE_SHARE,
      totalSupply: TOTAL_SUPPLY,
      graduationMcap: GRADUATION_MCAP,
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

  // Sign-In-With-Ethereum style: challenge, then signed challenge. See walletAuth.ts.
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
      const { username } = updateProfileSchema.parse(req.body);
      const user = storage.updateUsername(currentUser(req).id, username);
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
      res.json(storage.getActivity(parseLimit(req.query.limit, 60, 200)));
    }),
  );

  // ---- Coins --------------------------------------------------------------

  app.get(
    "/api/coins",
    wrap((req, res) => {
      const filters = coinListQuerySchema.parse({
        sort: queryString(req.query.sort),
        search: queryString(req.query.search),
      });
      const coins = storage.listCoins({ ...filters, limit: parseLimit(req.query.limit, 60, 200) });
      coins.forEach(rememberCa);
      res.json(coins);
    }),
  );

  // Must be registered before "/api/coins/:ca" or Express would treat "king" as a CA.
  app.get(
    "/api/coins/king",
    wrap((_req, res) => {
      const king = storage.getKing();
      if (king) rememberCa(king);
      res.json(king);
    }),
  );

  app.post(
    "/api/coins",
    requireAuth,
    wrap(async (req, res) => {
      const me = currentUser(req);
      const userKey = `user:${me.id}`;
      coinCreateLimiter.check(userKey, res, "You can launch at most 5 coins per hour. Please try again later.");
      const input = createCoinSchema.parse(req.body);

      // The CA is minted inside storage.createCoin, so the file gets a random name instead.
      const imageUrl = await saveImage(input.image, "coins", nanoid(), 512);
      let created: { coin: CoinDetail; trade: Trade | null };
      try {
        created = storage.createCoin(me, input, imageUrl);
      } catch (err) {
        // e.g. insufficient balance for the initial buy: don't leave an orphaned file behind.
        void deleteImage(imageUrl);
        throw err;
      }
      coinCreateLimiter.record(userKey);

      const { coin, trade } = created;
      rememberCa(coin);
      const summary = toSummary(coin);
      broadcast("coin:created", summary);
      if (trade) {
        broadcast("trade", { coin: summary, trade: { ...trade, user: storage.toPublicUser(me.id) } });
        const creator = storage.getUser(me.id);
        if (creator) broadcast("balance:updated", { userId: creator.id, balance: creator.balance });
      }
      res.status(201).json(coin);
    }),
  );

  app.get(
    "/api/coins/:ca",
    wrap((req, res) => {
      res.json(coinByCa(req.params.ca, req.user?.id));
    }),
  );

  app.get(
    "/api/coins/:ca/candles",
    wrap((req, res) => {
      const coin = coinByCa(req.params.ca);
      res.json(storage.getCandles(coin.id));
    }),
  );

  app.post(
    "/api/coins/:ca/quote",
    requireAuth,
    wrap((req, res) => {
      const coin = coinByCa(req.params.ca);
      const { side, amount } = tradeSchema.parse(req.body);
      res.json(storage.quote(coin.id, currentUser(req).id, side, amount));
    }),
  );

  app.post(
    "/api/coins/:ca/trade",
    requireAuth,
    wrap((req, res) => {
      const target = coinByCa(req.params.ca);
      const { side, amount, minOut } = tradeSchema.parse(req.body);
      const { trade, coin, user } = storage.trade(target.id, currentUser(req).id, side, amount, minOut);
      broadcast("trade", { coin, trade: { ...trade, user: storage.toPublicUser(user.id) } });
      // The creator just earned their fee share; let their open tabs refresh the balance.
      if (coin.creatorId !== user.id) {
        const creator = storage.getUser(coin.creatorId);
        if (creator) broadcast("balance:updated", { userId: creator.id, balance: creator.balance });
      }
      res.json({ trade, coin, user: storage.toSafeUser(user) });
    }),
  );

  // ---- Comments -----------------------------------------------------------

  app.post(
    "/api/coins/:ca/comments",
    requireAuth,
    wrap(async (req, res) => {
      const me = currentUser(req);
      const userKey = `user:${me.id}`;
      commentLimiter.check(userKey, res, "You're commenting too fast. Please wait a minute.");
      const coin = coinByCa(req.params.ca);
      const { body, image } = commentSchema.parse(req.body);

      const imageUrl = image ? await saveImage(image, "comments", nanoid(), 800) : undefined;
      let comment: CommentView;
      try {
        comment = storage.addComment(coin.id, me.id, body, imageUrl);
      } catch (err) {
        if (imageUrl) void deleteImage(imageUrl);
        throw err;
      }
      commentLimiter.record(userKey);

      broadcast("comment:created", { ...comment, ca: coin.ca });
      res.status(201).json(comment);
    }),
  );

  app.post(
    "/api/comments/:id/like",
    requireAuth,
    wrap((req, res) => {
      const id = parseId(req.params.id);
      const comment = storage.toggleLike(id, currentUser(req).id);
      broadcast("comment:updated", { ...comment, ca: coinCaById(comment.coinId) });
      res.json(comment);
    }),
  );

  // ---- Portfolio & wallet -------------------------------------------------

  app.get(
    "/api/portfolio",
    requireAuth,
    wrap((req, res) => {
      res.json(storage.getPortfolio(currentUser(req).id));
    }),
  );

  app.get(
    "/api/wallet",
    requireAuth,
    wrap((req, res) => {
      res.json(storage.getWallet(currentUser(req).id));
    }),
  );

  app.post(
    "/api/wallet/withdraw",
    requireAuth,
    wrap((req, res) => {
      const { toAddress, amount } = withdrawSchema.parse(req.body);
      const withdrawal = storage.requestWithdrawal(currentUser(req).id, toAddress, amount);
      // Pay out in the background; the client polls / listens for the final status.
      void processWithdrawal(withdrawal.id)
        .then((updated) => {
          if (updated.status !== "pending") {
            broadcast("withdrawal:updated", { userId: updated.userId, withdrawal: updated });
            if (updated.status === "failed") {
              // The refund landed back on the ledger.
              const owner = storage.getUser(updated.userId);
              if (owner) broadcast("balance:updated", { userId: owner.id, balance: owner.balance });
            }
          }
        })
        .catch((err) => log(`processing withdrawal #${withdrawal.id} failed: ${errorMessage(err)}`, "wallet"));
      res.status(201).json(withdrawal);
    }),
  );

  app.post(
    "/api/wallet/faucet",
    requireAuth,
    wrap((req, res) => {
      if (!config.chain.testnet) throw new HttpError(404, "The faucet is only available on testnets");
      const user = storage.faucet(currentUser(req).id);
      res.json(storage.toSafeUser(user));
    }),
  );

  // ---- Public profiles ----------------------------------------------------

  app.get(
    "/api/users/:username",
    wrap((req, res) => {
      const profile = storage.getPublicProfile(req.params.username);
      if (!profile) throw new HttpError(404, "User not found");
      profile.createdCoins.forEach(rememberCa);
      res.json(profile);
    }),
  );

  // ---- Admin --------------------------------------------------------------

  app.get(
    "/api/admin/users",
    requireAdmin,
    wrap((req, res) => {
      res.json(storage.listUsers(queryString(req.query.search) ?? "", parseLimit(req.query.limit, 100, 500)));
    }),
  );

  app.post(
    "/api/admin/users/credit",
    requireAdmin,
    wrap((req, res) => {
      const { username, amount } = adminCreditSchema.parse(req.body);
      const { user, queued } = storage.adminCreditBalance(username, amount);
      if (user) broadcast("balance:updated", { userId: user.id, balance: user.balance });
      res.json({ user: user ? storage.toSafeUser(user) : null, queued });
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
    // Anything else that already carries a 4xx status (other HttpError-like classes, body-parser
    // encoding errors...) is a client error we can surface as-is.
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
