import { useEffect, useSyncExternalStore } from "react";
import type { Query } from "@tanstack/react-query";
import type {
  CommentView,
  Deposit,
  MarketDetail,
  MarketSummary,
  PublicUser,
  SafeUser,
  Trade,
  Withdrawal,
} from "@shared/schema";
import { queryClient } from "./queryClient";
import { toast } from "@/hooks/use-toast";
import { usd } from "@/lib/format";

// ---------------------------------------------------------------------------
// Frame types (mirror server/routes.ts `broadcast(event, payload)` calls)
// ---------------------------------------------------------------------------

type LiveTrade = Trade & { user: PublicUser };

type LiveFrame =
  | { event: "market:updated"; payload: { market: MarketSummary; trade: LiveTrade } }
  | { event: "market:created"; payload: MarketSummary }
  | { event: "market:reviewed"; payload: MarketSummary }
  | { event: "market:resolved"; payload: MarketSummary }
  | { event: "comment:created"; payload: CommentView }
  | { event: "comment:updated"; payload: CommentView }
  | { event: "deposit"; payload: { userId: number; deposit: Deposit } }
  | { event: "withdrawal:updated"; payload: { userId: number; withdrawal: Withdrawal } };

export type LiveStatus = "connected" | "connecting" | "offline";

const RECENT_TRADES_CAP = 50;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 10_000;
const POLL_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Cache patch helpers
// ---------------------------------------------------------------------------

const isMarketListKey = (q: Query) => {
  const k = q.queryKey[0];
  return typeof k === "string" && (k === "/api/markets" || k.startsWith("/api/markets?"));
};

const isMarketsPrefixKey = (q: Query) => {
  const k = q.queryKey[0];
  return typeof k === "string" && k.startsWith("/api/markets");
};

const isMarketDetailKey = (q: Query) => {
  const k = q.queryKey[0];
  return typeof k === "string" && k.startsWith("/api/markets/");
};

/** Replace (by id) the given market in every cached list query. Lists that do not hold it are untouched. */
function patchMarketLists(market: MarketSummary) {
  queryClient.setQueriesData<MarketSummary[]>({ predicate: isMarketListKey }, (old) => {
    if (!Array.isArray(old)) return old;
    const idx = old.findIndex((m) => m.id === market.id);
    if (idx === -1) return old;
    const next = old.slice();
    next[idx] = { ...old[idx], ...market };
    return next;
  });
}

function patchMarketDetail(market: MarketSummary, trade: LiveTrade) {
  queryClient.setQueryData<MarketDetail>([`/api/markets/${market.slug}`], (old) => {
    if (!old) return old;
    const alreadyKnown = old.recentTrades.some((t) => t.id === trade.id);
    return {
      ...old,
      ...market,
      priceHistory: alreadyKnown ? old.priceHistory : [...old.priceHistory, { t: trade.createdAt, p: market.prices }],
      recentTrades: alreadyKnown ? old.recentTrades : [trade, ...old.recentTrades].slice(0, RECENT_TRADES_CAP),
      // Personal fields are not part of the broadcast; keep what we have.
      comments: old.comments,
      holders: old.holders,
      myPositions: old.myPositions,
    };
  });
}

function upsertComment(comment: CommentView) {
  for (const q of queryClient.getQueryCache().findAll({ predicate: isMarketDetailKey })) {
    const data = q.state.data as MarketDetail | undefined;
    if (!data || data.id !== comment.marketId) continue;
    queryClient.setQueryData<MarketDetail>(q.queryKey, (old) => {
      if (!old) return old;
      const idx = old.comments.findIndex((c) => c.id === comment.id);
      if (idx === -1) {
        return { ...old, comments: [comment, ...old.comments], commentCount: old.commentCount + 1 };
      }
      const comments = old.comments.slice();
      comments[idx] = comment;
      return { ...old, comments };
    });
  }
}

const currentUserId = () => (queryClient.getQueryData(["/api/me"]) as SafeUser | null | undefined)?.id;

function handleFrame(frame: LiveFrame) {
  switch (frame.event) {
    case "market:updated": {
      const { market, trade } = frame.payload;
      patchMarketLists(market);
      patchMarketDetail(market, trade);
      void queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      break;
    }
    case "market:created":
    case "market:reviewed":
      void queryClient.invalidateQueries({ predicate: isMarketsPrefixKey });
      void queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      break;
    case "market:resolved": {
      const market = frame.payload;
      patchMarketLists(market);
      void queryClient.invalidateQueries({ queryKey: [`/api/markets/${market.slug}`] });
      void queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      break;
    }
    case "comment:created":
    case "comment:updated":
      upsertComment(frame.payload);
      break;
    case "deposit": {
      const { userId, deposit } = frame.payload;
      if (userId !== currentUserId()) break;
      void queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      toast({ title: "Deposit confirmed", description: `${usd(deposit.amount)} USDC has been added to your balance.` });
      break;
    }
    case "withdrawal:updated": {
      const { userId, withdrawal } = frame.payload;
      if (userId !== currentUserId()) break;
      void queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      if (withdrawal.status === "sent") {
        toast({ title: "Withdrawal sent", description: `${usd(withdrawal.amount)} USDC is on its way.` });
      } else if (withdrawal.status === "failed") {
        toast({
          variant: "destructive",
          title: "Withdrawal failed",
          description: withdrawal.error ?? "Your funds have been returned to your balance.",
        });
      }
      break;
    }
  }
}

function parseFrame(raw: unknown): LiveFrame | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { event?: unknown; payload?: unknown };
    if (!parsed || typeof parsed.event !== "string") return null;
    return parsed as LiveFrame;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single shared socket with backoff reconnect + polling fallback
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let subscribers = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let backoff = BACKOFF_MIN_MS;
let status: LiveStatus = "offline";
const statusListeners = new Set<() => void>();

function setStatus(next: LiveStatus) {
  if (status === next) return;
  status = next;
  statusListeners.forEach((l) => l());
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    void queryClient.invalidateQueries({ predicate: isMarketsPrefixKey });
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer || subscribers === 0) return;
  const delay = backoff;
  backoff = Math.min(BACKOFF_MAX_MS, Math.round(backoff * 1.7));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (subscribers === 0) return;
  if (typeof WebSocket === "undefined") {
    setStatus("offline");
    startPolling();
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  setStatus("connecting");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch {
    setStatus("offline");
    startPolling();
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    backoff = BACKOFF_MIN_MS;
    stopPolling();
    setStatus("connected");
    // We may have missed events while offline; refresh what is on screen.
    void queryClient.invalidateQueries({ predicate: isMarketsPrefixKey });
  };
  ws.onmessage = (ev) => {
    const frame = parseFrame(ev.data);
    if (frame) handleFrame(frame);
  };
  ws.onerror = () => {
    // onclose always follows; nothing else to do here.
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (subscribers === 0) {
      setStatus("offline");
      return;
    }
    setStatus("offline");
    startPolling();
    scheduleReconnect();
  };
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopPolling();
  const ws = socket;
  socket = null;
  if (ws) {
    ws.onclose = null;
    ws.onmessage = null;
    ws.onopen = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  backoff = BACKOFF_MIN_MS;
  setStatus("offline");
}

function onOnline() {
  if (subscribers === 0) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  backoff = BACKOFF_MIN_MS;
  connect();
}

function onVisible() {
  if (document.visibilityState !== "visible" || subscribers === 0) return;
  if (!socket || socket.readyState === WebSocket.CLOSED) onOnline();
}

/**
 * Keeps one shared WebSocket to `/ws` alive while any subscriber is mounted and
 * applies incoming frames to the react-query cache. Call once near the root.
 */
export function useLiveUpdates(): void {
  useEffect(() => {
    subscribers++;
    if (subscribers === 1) {
      window.addEventListener("online", onOnline);
      document.addEventListener("visibilitychange", onVisible);
    }
    connect();
    return () => {
      subscribers--;
      if (subscribers === 0) {
        window.removeEventListener("online", onOnline);
        document.removeEventListener("visibilitychange", onVisible);
        disconnect();
      }
    };
  }, []);
}

function subscribeStatus(cb: () => void) {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

/** Current state of the shared realtime connection. */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(subscribeStatus, () => status, () => "offline" as LiveStatus);
}
