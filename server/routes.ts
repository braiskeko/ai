import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { createServer, type IncomingMessage, type Server } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
// @ts-ignore -- @types/cookie-parser is not installed (run `npm i -D @types/cookie-parser`); the runtime package is.
import cookieParser from "cookie-parser";
import { z, ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import {
  MARKET_STATUSES,
  adminCreditSchema,
  commentSchema,
  createMarketSchema,
  idTokenSchema,
  magicLinkRequestSchema,
  resolveMarketSchema,
  reviewMarketSchema,
  tradeSchema,
  updateProfileSchema,
  withdrawSchema,
  type AppConfig,
  type AuthProvider,
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
import { processWithdrawal, withdrawalsEnabled } from "./chain";
import { config } from "./config";
import { magicLinkDevMode, sendMagicLink } from "./email";
import { log } from "./vite";

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

// Query-string filters: `.catch(undefined)` makes unknown values act as "not provided"
// instead of failing the request.
const marketListQuerySchema = z.object({
  category: z.string().trim().min(1).max(40).optional().catch(undefined),
  status: z.enum(["open", "closed", "resolved", "all"]).optional().catch(undefined),
  search: z.string().trim().min(1).max(100).optional().catch(undefined),
  sort: z.enum(["volume", "newest", "ending", "trending"]).optional().catch(undefined),
});

const adminMarketStatusSchema = z.enum(MARKET_STATUSES).catch("pending");
const withdrawalStatusSchema = z.enum(["pending", "sent", "failed"]).optional().catch(undefined);
const adminWithdrawalUpdateSchema = z.object({
  status: z.enum(["sent", "failed"]),
  txHash: z.string().trim().min(1).max(120).optional(),
  error: z.string().trim().max(500).optional(),
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);
  wss = setupRealtime(httpServer);

  app.use(cookieParser());

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
      magicLinkDevMode,
      instantEmailLogin: config.instantEmailLogin,
      chain: config.chain,
      depositsEnabled: config.depositsEnabled,
      withdrawalsEnabled,
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
      const ipKey = `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
      if (magicLinkLimiter.isLimited(ipKey)) {
        res.set("Retry-After", String(Math.ceil(MAGIC_LINK_WINDOW_MS / 1000)));
        throw new HttpError(429, "Too many sign-in attempts. Please wait a few minutes and try again.");
      }
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
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const ipKey = `ip:${ip}`;
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
      res.redirect(302, "/markets?welcome=1");
    }),
  );

  const idTokenSignIn = (
    provider: Exclude<AuthProvider, "email">,
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

  app.get(
    "/api/me/markets",
    requireAuth,
    wrap((req, res) => {
      res.json(storage.listMyMarkets(currentUser(req).id));
    }),
  );

  // ---- Markets ------------------------------------------------------------

  app.get(
    "/api/stats",
    wrap((_req, res) => {
      res.json(storage.getStats());
    }),
  );

  app.get(
    "/api/markets",
    wrap((req, res) => {
      const filters = marketListQuerySchema.parse({
        category: queryString(req.query.category),
        status: queryString(req.query.status),
        search: queryString(req.query.search),
        sort: queryString(req.query.sort),
      });
      res.json(storage.listMarkets(filters));
    }),
  );

  app.post(
    "/api/markets",
    requireAuth,
    wrap((req, res) => {
      const input = createMarketSchema.parse(req.body);
      const market = storage.createMarket(currentUser(req), input);
      // Markets awaiting admin review are only visible to their creator.
      if (market.status === "open") broadcast("market:created", market);
      res.status(201).json(market);
    }),
  );

  app.get(
    "/api/markets/:slug",
    wrap((req, res) => {
      const market = storage.getMarketBySlug(req.params.slug, req.user);
      if (!market) throw new HttpError(404, "Market not found");
      res.json(market);
    }),
  );

  app.post(
    "/api/markets/:id/quote",
    requireAuth,
    wrap((req, res) => {
      const id = parseId(req.params.id);
      const { outcomeId, side, amount } = tradeSchema.parse(req.body);
      res.json(storage.quote(id, currentUser(req).id, outcomeId, side, amount));
    }),
  );

  app.post(
    "/api/markets/:id/trade",
    requireAuth,
    wrap((req, res) => {
      const id = parseId(req.params.id);
      const { outcomeId, side, amount } = tradeSchema.parse(req.body);
      const { trade, market, user } = storage.trade(id, currentUser(req).id, outcomeId, side, amount);
      broadcast("market:updated", { market, trade: { ...trade, user: storage.toPublicUser(user.id) } });
      res.json({ trade, market, user: storage.toSafeUser(user) });
    }),
  );

  // ---- Comments -----------------------------------------------------------

  app.post(
    "/api/markets/:id/comments",
    requireAuth,
    wrap((req, res) => {
      const id = parseId(req.params.id);
      const { body, parentId } = commentSchema.parse(req.body);
      const comment = storage.addComment(id, currentUser(req).id, body, parentId ?? undefined);
      broadcast("comment:created", comment);
      res.status(201).json(comment);
    }),
  );

  app.post(
    "/api/comments/:id/like",
    requireAuth,
    wrap((req, res) => {
      const id = parseId(req.params.id);
      const comment = storage.toggleLike(id, currentUser(req).id);
      broadcast("comment:updated", comment);
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
      const user = storage.faucet(currentUser(req).id);
      res.json(storage.toSafeUser(user));
    }),
  );

  // ---- Aggregates ---------------------------------------------------------

  app.get(
    "/api/leaderboard",
    wrap((_req, res) => {
      res.json(storage.getLeaderboard());
    }),
  );

  app.get(
    "/api/activity",
    wrap((req, res) => {
      res.json(storage.getActivity(parseLimit(req.query.limit, 40, 100)));
    }),
  );

  // ---- Admin --------------------------------------------------------------

  app.get(
    "/api/admin/markets",
    requireAdmin,
    wrap((req, res) => {
      const status = adminMarketStatusSchema.parse(queryString(req.query.status));
      res.json(storage.listMarketsByStatus(status));
    }),
  );

  app.post(
    "/api/admin/markets/:id/review",
    requireAdmin,
    wrap((req, res) => {
      const id = parseId(req.params.id);
      const { action, reason, featured } = reviewMarketSchema.parse(req.body);
      const market = storage.reviewMarket(id, action, reason, featured);
      broadcast("market:reviewed", market);
      res.json(market);
    }),
  );

  app.post(
    "/api/admin/markets/:id/resolve",
    requireAdmin,
    wrap((req, res) => {
      const id = parseId(req.params.id);
      const { outcomeId } = resolveMarketSchema.parse(req.body);
      const market = storage.resolveMarket(id, outcomeId);
      broadcast("market:resolved", market);
      res.json(market);
    }),
  );

  app.get(
    "/api/admin/withdrawals",
    requireAdmin,
    wrap((req, res) => {
      const status = withdrawalStatusSchema.parse(queryString(req.query.status));
      res.json(storage.listWithdrawals(status));
    }),
  );

  app.post(
    "/api/admin/withdrawals/:id",
    requireAdmin,
    wrap((req, res) => {
      const id = parseId(req.params.id);
      const { status, txHash, error } = adminWithdrawalUpdateSchema.parse(req.body);
      const withdrawal = storage.updateWithdrawal(id, { status, txHash, error });
      broadcast("withdrawal:updated", { userId: withdrawal.userId, withdrawal });
      res.json(withdrawal);
    }),
  );

  app.get(
    "/api/admin/users",
    requireAdmin,
    wrap((req, res) => {
      res.json(storage.listUsers(queryString(req.query.search) ?? ""));
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
      res.status(413).json({ message: "Request body too large" });
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
