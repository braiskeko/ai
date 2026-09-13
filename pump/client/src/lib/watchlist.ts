import { useCallback, useEffect, useState } from "react";

/**
 * The tokens someone stars, kept in this browser.
 *
 * Deliberately local: a watchlist is a per-device convenience, not account data,
 * and keeping it out of the server means it works signed out too. Entries are
 * token ids (`solana:<mint>`) or a coin's mint, so anything the app can link to
 * can be starred.
 */

const KEY = "nx_watchlist";
/** Same-tab listeners; `storage` only fires in other tabs. */
const listeners = new Set<(ids: string[]) => void>();

function read(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(0, 300)));
  } catch {
    /* storage unavailable — the list simply does not persist */
  }
  listeners.forEach((fn) => fn(ids));
}

export function useWatchlist() {
  const [ids, setIds] = useState<string[]>(read);

  useEffect(() => {
    const onChange = (next: string[]) => setIds(next);
    listeners.add(onChange);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setIds(read());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const toggle = useCallback((id: string) => {
    const current = read();
    write(current.includes(id) ? current.filter((x) => x !== id) : [id, ...current]);
  }, []);

  const has = useCallback((id: string) => ids.includes(id), [ids]);

  return { ids, has, toggle };
}
