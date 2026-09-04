import { useEffect } from "react";
import { queryClient } from "./queryClient";
import type { MarketSummary, MarketDetail, Trade, PublicUser, Comment } from "@shared/schema";

type LiveEvent =
  | { event: "market:updated"; payload: { market: MarketSummary; trade: Trade & { user: PublicUser } } }
  | { event: "market:created"; payload: MarketSummary }
  | { event: "market:resolved"; payload: MarketSummary }
  | { event: "comment:created"; payload: Comment & { user: PublicUser } };

let socket: WebSocket | null = null;
let subscribers = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function patchMarketLists(market: MarketSummary) {
  queryClient.setQueriesData<MarketSummary[]>({ queryKey: ["/api/markets"] }, (old) => {
    if (!old) return old;
    const idx = old.findIndex((m) => m.id === market.id);
    if (idx === -1) return old;
    const next = [...old];
    next[idx] = { ...old[idx], ...market };
    return next;
  });
}

function handle(msg: LiveEvent) {
  switch (msg.event) {
    case "market:updated": {
      const { market, trade } = msg.payload;
      patchMarketLists(market);
      queryClient.setQueryData<MarketDetail>([`/api/markets/${market.slug}`], (old) => {
        if (!old) return old;
        return {
          ...old,
          ...market,
          priceHistory: [...old.priceHistory, { t: trade.createdAt as unknown as string, p: trade.priceAfter }],
          recentTrades: [trade, ...old.recentTrades].slice(0, 30),
          myPositions: old.myPositions,
        };
      });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      break;
    }
    case "market:created":
      queryClient.invalidateQueries({ queryKey: ["/api/markets"] });
      break;
    case "market:resolved":
      patchMarketLists(msg.payload);
      queryClient.invalidateQueries({ queryKey: [`/api/markets/${msg.payload.slug}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      break;
    case "comment:created": {
      const c = msg.payload;
      for (const q of queryClient.getQueryCache().findAll()) {
        const key = q.queryKey[0];
        if (typeof key !== "string" || !key.startsWith("/api/markets/")) continue;
        queryClient.setQueryData<MarketDetail>(q.queryKey, (old) => {
          if (!old || old.id !== c.marketId) return old;
          if (old.comments.some((x) => x.id === c.id)) return old;
          return { ...old, comments: [c, ...old.comments] };
        });
      }
      break;
    }
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data) as LiveEvent);
    } catch {
      /* ignore malformed frames */
    }
  };
  socket.onclose = () => {
    socket = null;
    if (subscribers > 0 && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    }
  };
}

/** Keep one shared WebSocket alive while any component is mounted. */
export function useLiveUpdates() {
  useEffect(() => {
    subscribers++;
    connect();
    return () => {
      subscribers--;
      if (subscribers === 0) {
        socket?.close();
        socket = null;
      }
    };
  }, []);
}
