import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import cookieParser from "cookie-parser";
import { ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { storage, HttpError, randomUsername } from "./storage";
import {
  createMarketSchema,
  resolveMarketSchema,
  tradeSchema,
  commentSchema,
  updateProfileSchema,
  MARKET_CATEGORIES,
  type User,
} from "@shared/schema";

declare global {
  namespace Express {
    interface Request {
      user: User;
    }
  }
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Wrap async handlers so thrown errors reach the error middleware. */
const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid id");
  return id;
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // ---------------------------------------------------------------------------
  // Live updates: broadcast market changes to every connected client.
  // ---------------------------------------------------------------------------
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const broadcast = (event: string, payload: unknown) => {
    const msg = JSON.stringify({ event, payload });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  };

  app.use(cookieParser());

  // ---------------------------------------------------------------------------
  // Session: every visitor gets a demo account with play-money balance.
  // ---------------------------------------------------------------------------
  app.use("/api", async (req, res, next) => {
    try {
      let sessionId: string | undefined = req.cookies.sessionId;
      let user = sessionId ? await storage.getUserBySessionId(sessionId) : undefined;

      if (!user) {
        sessionId = nanoid();
        res.cookie("sessionId", sessionId, {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          maxAge: 365 * 24 * 60 * 60 * 1000,
        });
        const username = randomUsername();
        user = await storage.createUser({ sessionId, username, avatarSeed: sessionId });
      }
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------------------
  // Me
  // ---------------------------------------------------------------------------
  app.get(
    "/api/me",
    wrap(async (req, res) => {
      const { sessionId: _s, ...safe } = req.user;
      res.json(safe);
    }),
  );

  app.patch(
    "/api/me",
    wrap(async (req, res) => {
      const { username } = updateProfileSchema.parse(req.body);
      const user = await storage.updateUsername(req.user.id, username);
      const { sessionId: _s, ...safe } = user;
      res.json(safe);
    }),
  );

  app.get(
    "/api/portfolio",
    wrap(async (req, res) => {
      res.json(await storage.getPortfolio(req.user.id));
    }),
  );

  // ---------------------------------------------------------------------------
  // Markets
  // ---------------------------------------------------------------------------
  app.get("/api/categories", (_req, res) => res.json(MARKET_CATEGORIES));

  app.get(
    "/api/markets",
    wrap(async (req, res) => {
      const { category, status, search, sort } = req.query as Record<string, string | undefined>;
      const list = await storage.listMarkets({
        category,
        status,
        search,
        sort: sort as "volume" | "newest" | "ending" | "trending" | undefined,
      });
      res.json(list);
    }),
  );

  app.post(
    "/api/markets",
    wrap(async (req, res) => {
      const input = createMarketSchema.parse(req.body);
      const market = await storage.createMarket(req.user.id, input);
      broadcast("market:created", market);
      res.status(201).json(market);
    }),
  );

  app.get(
    "/api/markets/:slug",
    wrap(async (req, res) => {
      const market = await storage.getMarketBySlug(req.params.slug, req.user.id);
      if (!market) throw new HttpError(404, "Market not found");
      res.json(market);
    }),
  );

  app.post(
    "/api/markets/:id/quote",
    wrap(async (req, res) => {
      const id = parseId(req.params.id);
      const { outcome, side, amount } = tradeSchema.parse(req.body);
      res.json(await storage.quote(id, req.user.id, outcome, side, amount));
    }),
  );

  app.post(
    "/api/markets/:id/trade",
    wrap(async (req, res) => {
      const id = parseId(req.params.id);
      const { outcome, side, amount } = tradeSchema.parse(req.body);
      const result = await storage.trade(id, req.user.id, outcome, side, amount);
      broadcast("market:updated", {
        market: result.market,
        trade: { ...result.trade, user: { id: result.user.id, username: result.user.username, avatarSeed: result.user.avatarSeed } },
      });
      const { sessionId: _s, ...safeUser } = result.user;
      res.json({ trade: result.trade, market: result.market, user: safeUser });
    }),
  );

  app.post(
    "/api/markets/:id/resolve",
    wrap(async (req, res) => {
      const id = parseId(req.params.id);
      const { outcome } = resolveMarketSchema.parse(req.body);
      const market = await storage.resolveMarket(id, req.user.id, outcome);
      broadcast("market:resolved", market);
      res.json(market);
    }),
  );

  app.post(
    "/api/markets/:id/comments",
    wrap(async (req, res) => {
      const id = parseId(req.params.id);
      const { body } = commentSchema.parse(req.body);
      const comment = await storage.addComment(id, req.user.id, body);
      broadcast("comment:created", comment);
      res.status(201).json(comment);
    }),
  );

  // ---------------------------------------------------------------------------
  // Aggregates
  // ---------------------------------------------------------------------------
  app.get(
    "/api/leaderboard",
    wrap(async (_req, res) => {
      res.json(await storage.getLeaderboard());
    }),
  );

  app.get(
    "/api/activity",
    wrap(async (req, res) => {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
      res.json(await storage.getActivity(limit));
    }),
  );

  // ---------------------------------------------------------------------------
  // Error handling for /api
  // ---------------------------------------------------------------------------
  app.use("/api", (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ message: fromZodError(err).message });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ message: err.message });
    }
    console.error(err);
    res.status(500).json({ message: "Internal Server Error" });
  });

  return httpServer;
}
