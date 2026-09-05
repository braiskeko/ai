import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Query } from "@tanstack/react-query";
import type {
  Candle,
  CoinDetail,
  CoinSummary,
  CommentView,
  Deposit,
  PublicUser,
  SafeUser,
  Trade,
  Withdrawal,
} from "@shared/schema";
import { CANDLE_INTERVAL_MS } from "@shared/schema";
import { queryClient } from "./queryClient";
import { toast } from "@/hooks/use-toast";
import { usd } from "@/lib/format";
import { translate as t } from "@/i18n";

// ---------------------------------------------------------------------------
// Frame types (mirror server/routes.ts `broadcast(event, payload)` calls)
// ---------------------------------------------------------------------------

export type LiveTrade = Trade & { user: PublicUser };
export interface LiveTradeItem {
  coin: CoinSummary;
  trade: LiveTrade;
}
export type LiveComment = CommentView & { ca: string };

export type LiveFrame =
  | { event: "coin:created"; payload: CoinSummary }
  | { event: "trade"; payload: LiveTradeItem }
  | { event: "comment:created"; payload: LiveComment }
  | { event: "comment:updated"; payload: LiveComment }
  | { event: "deposit"; payload: { userId: number; deposit: Deposit } }
  | { event: "withdrawal:updated"; payload: { userId: number; withdrawal: Withdrawal } }
  | { event: "balance:updated"; payload: { userId: number; balance: number } };

export type LiveEvent = LiveFrame["event"];
export type LivePayload<E extends LiveEvent> = Extract<LiveFrame, { event: E }>["payload"];

export type LiveStatus = "connected" | "connecting" | "offline";

const RECENT_TRADES_CAP = 200;
const LIVE_TRADES_STORE_CAP = 100;
const RECENT_COIN_TTL_MS = 30_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 10_000;
const POLL_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Cache patch helpers
// ---------------------------------------------------------------------------

const keyString = (q: Query) => {
  const k = q.queryKey[0];
  return typeof k === "string" ? k : "";
};

/** ["/api/coins?sort=…"] style list queries */
const isCoinListKey = (q: Query) => {
  const k = keyString(q);
  return k === "/api/coins" || k.startsWith("/api/coins?");
};

/** Anything under /api/coins (lists, king, details, candles) */
const isCoinsPrefixKey = (q: Query) => keyString(q).startsWith("/api/coins");

const isCoinDetailKey = (q: Query) => {
  const k = keyString(q);
  return k.startsWith("/api/coins/") && k !== "/api/coins/king" && !k.endsWith("/candles");
};

/** A list key is "newest first" when it has no sort or sort=new, and no search term. */
function listShowsNewest(key: string): boolean {
  const qs = key.includes("?") ? key.slice(key.indexOf("?") + 1) : "";
  const params = new URLSearchParams(qs);
  const sort = params.get("sort") ?? "new";
  const search = params.get("search") ?? params.get("q") ?? "";
  return sort === "new" && !search;
}

/** Replace (by id) the given coin in every cached list query. Lists that do not hold it are untouched. */
function patchCoinLists(coin: CoinSummary) {
  queryClient.setQueriesData<CoinSummary[]>({ predicate: isCoinListKey }, (old) => {
    if (!Array.isArray(old)) return old;
    const idx = old.findIndex((c) => c.id === coin.id);
    if (idx === -1) return old;
    const next = old.slice();
    next[idx] = { ...old[idx], ...coin };
    return next;
  });
}

/** Prepend a brand-new coin to every "newest first" list; other lists are refetched. */
function prependCoin(coin: CoinSummary) {
  let touchedOther = false;
  for (const q of queryClient.getQueryCache().findAll({ predicate: isCoinListKey })) {
    const key = keyString(q);
    if (listShowsNewest(key)) {
      queryClient.setQueryData<CoinSummary[]>(q.queryKey, (old) => {
        if (!Array.isArray(old)) return old;
        if (old.some((c) => c.id === coin.id)) return old;
        return [coin, ...old];
      });
    } else {
      touchedOther = true;
    }
  }
  if (touchedOther) {
    void queryClient.invalidateQueries({
      predicate: (q) => isCoinListKey(q) && !listShowsNewest(keyString(q)),
    });
  }
}

/** Fold a trade into 1-minute candles (mutates nothing; returns a new array). */
export function applyTradeToCandles(candles: Candle[], trade: Trade): Candle[] {
  const bucket = Math.floor(Date.parse(trade.createdAt) / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
  const last = candles[candles.length - 1];
  if (last && last.t === bucket) {
    const updated: Candle = {
      ...last,
      h: Math.max(last.h, trade.price),
      l: Math.min(last.l, trade.price),
      c: trade.price,
      v: last.v + trade.usdc,
    };
    return [...candles.slice(0, -1), updated];
  }
  if (last && last.t > bucket) {
    // out-of-order (clock skew); fold into the latest candle rather than corrupting the series
    return applyTradeToCandles(candles, { ...trade, createdAt: new Date(last.t).toISOString() });
  }
  const open = last ? last.c : trade.price;
  return [
    ...candles,
    { t: bucket, o: open, h: Math.max(open, trade.price), l: Math.min(open, trade.price), c: trade.price, v: trade.usdc },
  ];
}

function patchCoinDetail(coin: CoinSummary, trade: LiveTrade) {
  const me = currentUserId();
  queryClient.setQueryData<CoinDetail>([`/api/coins/${coin.ca}`], (old) => {
    if (!old) return old;
    const alreadyKnown = old.recentTrades.some((x) => x.id === trade.id);
    return {
      ...old,
      ...coin,
      candles: alreadyKnown ? old.candles : applyTradeToCandles(old.candles, trade),
      recentTrades: alreadyKnown ? old.recentTrades : [trade, ...old.recentTrades].slice(0, RECENT_TRADES_CAP),
      // Personal / heavy fields are not part of the broadcast; keep what we have.
      commentsList: old.commentsList,
      topHolders: old.topHolders,
      myHolding: old.myHolding,
    };
  });
  queryClient.setQueryData<Candle[]>([`/api/coins/${coin.ca}/candles`], (old) =>
    Array.isArray(old) ? applyTradeToCandles(old, trade) : old,
  );
  // My own trade changes my holding/top holders: refetch the detail quietly.
  if (me !== undefined && trade.userId === me) {
    void queryClient.invalidateQueries({ queryKey: [`/api/coins/${coin.ca}`] });
  }
}

function patchKing(coin: CoinSummary) {
  const king = queryClient.getQueryData<CoinSummary | null>(["/api/coins/king"]);
  if (king === undefined) return;
  if (king && king.id === coin.id) {
    queryClient.setQueryData<CoinSummary | null>(["/api/coins/king"], { ...king, ...coin });
  } else if (!king || coin.marketCap > king.marketCap) {
    void queryClient.invalidateQueries({ queryKey: ["/api/coins/king"] });
  }
}

function upsertComment(comment: LiveComment) {
  queryClient.setQueryData<CoinDetail>([`/api/coins/${comment.ca}`], (old) => {
    if (!old) return old;
    const idx = old.commentsList.findIndex((c) => c.id === comment.id);
    if (idx === -1) {
      return { ...old, commentsList: [comment, ...old.commentsList], comments: old.comments + 1 };
    }
    const commentsList = old.commentsList.slice();
    commentsList[idx] = { ...commentsList[idx], ...comment };
    return { ...old, commentsList };
  });
  queryClient.setQueriesData<CoinSummary[]>({ predicate: isCoinListKey }, (old) => {
    if (!Array.isArray(old)) return old;
    const idx = old.findIndex((c) => c.id === comment.coinId);
    if (idx === -1) return old;
    const next = old.slice();
    const known = queryClient.getQueryData<CoinDetail>([`/api/coins/${comment.ca}`]);
    next[idx] = { ...old[idx], comments: known ? known.comments : old[idx].comments };
    return next;
  });
}

const currentUserId = () => (queryClient.getQueryData(["/api/me"]) as SafeUser | null | undefined)?.id;

// ---------------------------------------------------------------------------
// Small external stores: live trades (ticker/feed) and recently created coins
// ---------------------------------------------------------------------------

let liveTrades: LiveTradeItem[] = [];
const tradeListeners = new Set<() => void>();

function pushLiveTrade(item: LiveTradeItem) {
  if (liveTrades.some((x) => x.trade.id === item.trade.id)) return;
  liveTrades = [item, ...liveTrades].slice(0, LIVE_TRADES_STORE_CAP);
  tradeListeners.forEach((l) => l());
}

let recentCoins: { id: number; at: number }[] = [];
const recentListeners = new Set<() => void>();

function markRecentCoin(id: number) {
  const now = Date.now();
  recentCoins = [{ id, at: now }, ...recentCoins.filter((c) => c.id !== id && now - c.at < RECENT_COIN_TTL_MS)];
  recentListeners.forEach((l) => l());
  setTimeout(() => {
    const cutoff = Date.now() - RECENT_COIN_TTL_MS;
    const next = recentCoins.filter((c) => c.at > cutoff);
    if (next.length !== recentCoins.length) {
      recentCoins = next;
      recentListeners.forEach((l) => l());
    }
  }, RECENT_COIN_TTL_MS + 50);
}

// ---------------------------------------------------------------------------
// Custom event listeners (pages subscribe for toasts, chart markers, …)
// ---------------------------------------------------------------------------

type Handler<E extends LiveEvent> = (payload: LivePayload<E>) => void;
const eventListeners = new Map<LiveEvent, Set<Handler<LiveEvent>>>();

/** Subscribe to a raw live event. Returns the unsubscribe function. */
export function onLiveEvent<E extends LiveEvent>(event: E, handler: Handler<E>): () => void {
  let set = eventListeners.get(event);
  if (!set) {
    set = new Set();
    eventListeners.set(event, set);
  }
  const h = handler as unknown as Handler<LiveEvent>;
  set.add(h);
  return () => {
    set?.delete(h);
  };
}

function emit(frame: LiveFrame) {
  const set = eventListeners.get(frame.event);
  if (!set) return;
  set.forEach((h) => {
    try {
      h(frame.payload);
    } catch {
      /* listener errors must not break the socket */
    }
  });
}

function handleFrame(frame: LiveFrame) {
  switch (frame.event) {
    case "coin:created": {
      const coin = frame.payload;
      prependCoin(coin);
      markRecentCoin(coin.id);
      patchKing(coin);
      void queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      break;
    }
    case "trade": {
      const { coin, trade } = frame.payload;
      patchCoinLists(coin);
      patchCoinDetail(coin, trade);
      patchKing(coin);
      pushLiveTrade(frame.payload);
      void queryClient.invalidateQueries({ queryKey: ["/api/activity"], exact: false });
      void queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      const me = currentUserId();
      if (me !== undefined && (trade.userId === me || coin.creatorId === me)) {
        void queryClient.invalidateQueries({ queryKey: ["/api/me"] });
        void queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      }
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
      toast({
        title: t("common.depositConfirmed", { amount: usd(deposit.amount) }),
        description: t("common.depositCredited", { amount: usd(deposit.amount) }),
      });
      break;
    }
    case "balance:updated": {
      const { userId, balance } = frame.payload;
      if (userId !== currentUserId()) break;
      void queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      toast({ title: t("admin.balanceUpdated"), description: t("common.balanceUpdated", { amount: usd(balance) }) });
      break;
    }
    case "withdrawal:updated": {
      const { userId, withdrawal } = frame.payload;
      if (userId !== currentUserId()) break;
      void queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      if (withdrawal.status === "sent") {
        toast({
          title: t("common.withdrawalSent"),
          description: t("common.withdrawalOnItsWay", { amount: usd(withdrawal.amount) }),
        });
      } else if (withdrawal.status === "failed") {
        toast({
          variant: "destructive",
          title: t("common.withdrawalFailed"),
          description: withdrawal.error ?? t("common.fundsReturned"),
        });
      }
      break;
    }
  }
  emit(frame);
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

function refreshVisible() {
  void queryClient.invalidateQueries({ predicate: isCoinsPrefixKey });
  void queryClient.invalidateQueries({ queryKey: ["/api/activity"], exact: false });
  void queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    refreshVisible();
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
    refreshVisible();
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
    setStatus("offline");
    if (subscribers === 0) return;
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

function subscribeTrades(cb: () => void) {
  tradeListeners.add(cb);
  return () => {
    tradeListeners.delete(cb);
  };
}

/**
 * Trades received over the socket during this session, newest first (capped at
 * `limit`). Merge with `/api/activity` for an initial backlog (see LiveTicker).
 */
export function useLiveTrades(limit = 30): LiveTradeItem[] {
  const all = useSyncExternalStore(subscribeTrades, () => liveTrades, () => liveTrades);
  return useMemo(() => (all.length > limit ? all.slice(0, limit) : all), [all, limit]);
}

function subscribeRecent(cb: () => void) {
  recentListeners.add(cb);
  return () => {
    recentListeners.delete(cb);
  };
}

/** Ids of coins that arrived live in the last 30 seconds (drive the "highlight" entrance animation). */
export function useRecentlyCreatedIds(): ReadonlySet<number> {
  const list = useSyncExternalStore(subscribeRecent, () => recentCoins, () => recentCoins);
  return useMemo(() => new Set(list.map((c) => c.id)), [list]);
}

/** React hook wrapper over `onLiveEvent`; the handler may change between renders. */
export function useLiveEvent<E extends LiveEvent>(event: E, handler: Handler<E>): void {
  useEffect(() => onLiveEvent(event, handler), [event, handler]);
}
