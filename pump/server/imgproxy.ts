/**
 * Image proxy for remote token icons.
 *
 * Token metadata points anywhere: IPFS gateways that rate-limit browsers, hosts
 * that refuse hot-linking, `ipfs://` URIs no browser understands, and plain HTTP
 * URLs a HTTPS page is not allowed to load. Fetching them server-side and
 * re-serving from our own origin makes every icon render — and lets us cache the
 * bytes, so a listing of 40 tokens costs the upstreams 40 requests once.
 *
 * Anything that accepts a URL from a client can be turned into an SSRF probe, so
 * the target is resolved first and rejected unless every address it resolves to
 * is a public one; redirects are followed by hand under the same rule.
 */
import { lookup } from "dns/promises";
import { isIP } from "net";
import type { Request, Response } from "express";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** Bytes kept in memory across all cached icons. */
const CACHE_BUDGET = 48 * 1024 * 1024;
/** Largest single response worth caching. */
const CACHE_ITEM_MAX = 512 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a failure is remembered, so dead links are not re-fetched on every render. */
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const ARWEAVE_GATEWAY = "https://arweave.net/";

interface Entry {
  body: Buffer;
  type: string;
  at: number;
}

const cache = new Map<string, Entry>();
const failures = new Map<string, number>();
let cacheBytes = 0;

function remember(key: string, entry: Entry): void {
  if (entry.body.length > CACHE_ITEM_MAX) return;
  cache.set(key, entry);
  cacheBytes += entry.body.length;
  // Map iteration is insertion-ordered, so the first key is the oldest.
  while (cacheBytes > CACHE_BUDGET) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const victim = cache.get(oldest.value);
    cache.delete(oldest.value);
    cacheBytes -= victim?.body.length ?? 0;
  }
}

/** Turns the URI forms token metadata uses into something fetchable over HTTPS. */
export function normalizeImageUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.startsWith("ipfs://")) return IPFS_GATEWAY + v.slice("ipfs://".length).replace(/^ipfs\//, "");
  if (v.startsWith("ar://")) return ARWEAVE_GATEWAY + v.slice("ar://".length);
  if (/^https?:\/\//i.test(v)) return v;
  return null;
}

/** RFC1918 / loopback / link-local / unique-local — everything that is not the public internet. */
function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return a >= 224;
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase();
    if (ip6 === "::1" || ip6 === "::") return true;
    if (ip6.startsWith("fe80") || ip6.startsWith("fc") || ip6.startsWith("fd")) return true;
    // IPv4-mapped (::ffff:10.0.0.1) resolves to the v4 rules above.
    const mapped = ip6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

async function resolvesToPublicHost(hostname: string): Promise<boolean> {
  if (isIP(hostname)) return !isPrivateAddress(hostname);
  try {
    const addresses = await lookup(hostname, { all: true });
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/** Fetches `url`, following redirects by hand so each hop is re-validated. */
async function fetchImage(url: string): Promise<{ body: Buffer; type: string } | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!(await resolvesToPublicHost(parsed.hostname))) return null;

    const res = await fetch(parsed.toString(), {
      redirect: "manual",
      headers: { accept: "image/*,*/*;q=0.8", "user-agent": "Mozilla/5.0 (compatible; NextBot/1.0)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      current = new URL(location, parsed).toString();
      continue;
    }
    if (!res.ok) return null;

    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return null;

    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0 || body.length > MAX_BYTES) return null;
    return { body, type };
  }
  return null;
}

/**
 * `GET /api/img?u=<url>` — the icon, from cache when we have it. Failures answer
 * 404 so the client can fall back to its initials tile.
 */
export async function imageProxy(req: Request, res: Response): Promise<void> {
  const raw = typeof req.query.u === "string" ? req.query.u : "";
  const url = raw.length <= 2048 ? normalizeImageUrl(raw) : null;
  if (!url) {
    res.status(400).end();
    return;
  }

  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    send(res, hit.body, hit.type);
    return;
  }
  const failedAt = failures.get(url);
  if (failedAt !== undefined && now - failedAt < NEGATIVE_TTL_MS) {
    res.status(404).end();
    return;
  }

  try {
    const image = await fetchImage(url);
    if (!image) {
      failures.set(url, now);
      res.status(404).end();
      return;
    }
    failures.delete(url);
    remember(url, { ...image, at: now });
    send(res, image.body, image.type);
  } catch {
    failures.set(url, now);
    res.status(404).end();
  }
}

function send(res: Response, body: Buffer, type: string): void {
  res.setHeader("Content-Type", type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.end(body);
}
