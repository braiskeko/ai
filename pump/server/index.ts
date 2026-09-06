import express, { type NextFunction, type Request, type Response } from "express";
import { broadcast, closeRealtime, registerRoutes } from "./routes";
import { log, serveStatic, setupVite } from "./vite";
import { config } from "./config";
import * as indexer from "./indexer";
import { ensureMetaDir } from "./meta";
import { seedDemo } from "./seed";
import { getSolUsd, launchEnabled, startSolUsdRefresh, stopSolUsdRefresh } from "./solana";
import { initStorage, storage } from "./storage";
import { UPLOADS_ROOT, ensureUploadDirs } from "./uploads";
import * as vanity from "./vanity";

const SHUTDOWN_TIMEOUT_MS = 8_000;

const app = express();
// Behind a single reverse proxy (cPanel/Passenger, Render, Fly...) so req.ip is the real client for rate limiting.
app.set("trust proxy", 1);
// Coin images and comment attachments travel as base64 data URLs inside the JSON body (≤ 2 MB each).
app.use(express.json({ limit: "3mb" }));
app.use(express.urlencoded({ extended: false }));

// Request log for API calls: method, path, status, duration. Bodies are deliberately
// not logged (they contain emails, wallet addresses and image payloads).
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  res.on("finish", () => {
    if (!path.startsWith("/api")) return;
    log(`${req.method} ${path} ${res.statusCode} in ${Date.now() - start}ms`);
  });
  next();
});

/** Applies DEMO_FIGURES (see config.ts) over the accounts it names. */
function applyDemoFigures(): void {
  if (!config.demoFigures.trim()) return;
  try {
    const parsed = JSON.parse(config.demoFigures) as Record<string, { pnlUsd?: number; cashUsd?: number }>;
    const solUsd = Math.max(getSolUsd(), 1e-9);
    for (const [handle, figures] of Object.entries(parsed)) {
      storage.setDemo(handle, {
        pnlSol: figures.pnlUsd === undefined ? undefined : figures.pnlUsd / solUsd,
        balanceSol: figures.cashUsd === undefined ? undefined : figures.cashUsd / solUsd,
      });
      log(`showcase figures applied to @${handle}`, "config");
    }
  } catch (err) {
    log(`DEMO_FIGURES ignored (${(err as Error).message})`, "config");
  }
}

async function main(): Promise<void> {
  if (config.sessionSecretIsEphemeral) log("SESSION_SECRET not set: sessions reset on restart", "config");
  if (!config.databaseUrl) log(`DATABASE_URL not set: persisting to ${config.dataFile}`, "config");
  log(`cluster ${config.solana.cluster} via ${config.solana.rpcUrl}`, "config");
  if (!launchEnabled) log("DBC_CONFIG not set: coin creation is disabled", "config");

  // Uploaded images and metadata documents live outside the snapshot.
  await ensureUploadDirs();
  await ensureMetaDir();
  log(`uploads stored in ${UPLOADS_ROOT}`, "config");

  // 1. storage (snapshot + persistence), 2. chain indexer, 3. HTTP/WS routes.
  await initStorage();
  applyDemoFigures();
  await vanity.init();
  startSolUsdRefresh();

  // The indexer broadcasts through the WebSocket, which routes.ts owns; wire the
  // seam before starting it so nothing is dropped between the two.
  indexer.setBroadcaster((event, payload) => broadcast(event, payload as Record<string, unknown>));
  await indexer.start();
  seedDemo();

  const server = await registerRoutes(app);

  // Last-resort handler for errors outside /api (Vite / static serving). Respond and stop;
  // rethrowing after a response has been sent would crash the process.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = (err ?? {}) as { status?: unknown; statusCode?: unknown; message?: unknown };
    const status =
      typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 500;
    const message = typeof e.message === "string" && status < 500 ? e.message : "Internal Server Error";
    if (status >= 500) console.error(err);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json({ message });
  });

  // Vite (dev) / static (prod) must be registered after the API so its catch-all
  // route does not shadow /api or /uploads.
  if (!config.isProd) {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Serves both the API and the client on the single exposed port.
  server.listen({ port: config.port, host: "0.0.0.0", reusePort: true }, () => {
    log(`${config.appName} serving on port ${config.port} (${config.isProd ? "production" : "development"})`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, shutting down`);

    indexer.stop();
    stopSolUsdRefresh();
    closeRealtime();

    let forceTimer: NodeJS.Timeout | undefined;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const timedOut = new Promise<void>((resolve) => {
      forceTimer = setTimeout(() => {
        log(`connections still open after ${SHUTDOWN_TIMEOUT_MS}ms, exiting anyway`);
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
    });

    try {
      await storage.flush();
      await Promise.race([closed, timedOut]);
      // In-flight requests may have mutated state while we drained.
      await storage.flush();
    } catch (err) {
      console.error("error during shutdown", err);
      process.exit(1);
    } finally {
      if (forceTimer) clearTimeout(forceTimer);
    }
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal: failed to start server", err);
  process.exit(1);
});
