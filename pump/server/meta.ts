/**
 * Off-chain token metadata.
 *
 * The Metaplex metadata account only holds `name`, `symbol` and a `uri`. That
 * uri points back at us (`/api/meta/<mint>.json`) and the JSON we serve there is
 * what wallets and explorers read for the image, description and socials.
 *
 * The files live in `META_DIR` (one per mint) and are written before the coin
 * exists on chain, because the uri has to be part of the creation transaction.
 * When the indexer later discovers the pool it reads the file back to restore
 * the description / image / links a coin was launched with.
 */
import { promises as fs } from "fs";
import path from "path";
import { SOLANA_ADDRESS_RE } from "@shared/schema";
import { config } from "./config";

const ROOT = path.resolve(config.metaDir);

/** The Metaplex off-chain JSON schema, as we emit it. */
export interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  /** absolute URL */
  image: string;
  external_url?: string;
  extensions?: {
    website?: string;
    twitter?: string;
    telegram?: string;
  };
  properties?: {
    files?: { uri: string; type: string }[];
    category?: string;
  };
}

export async function ensureMetaDir(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
}

/** Absolute URL for a path served by us ("/uploads/x.webp" -> "https://…/uploads/x.webp"). */
export function absoluteUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = config.appUrl.replace(/\/+$/, "");
  return `${base}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

/** The metadata uri baked into the mint's on-chain metadata account. */
export function metadataUri(mint: string): string {
  return absoluteUrl(`/api/meta/${mint}.json`);
}

/** The mint a `/api/meta/<mint>.json` uri refers to, or null when it is not ours. */
export function mintFromMetadataUri(uri: string): string | null {
  const match = /\/api\/meta\/([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(uri.trim());
  if (!match) return null;
  const base = config.appUrl.replace(/\/+$/, "");
  // Accept our own host only; a coin can point its uri anywhere.
  if (/^https?:\/\//i.test(uri) && !uri.startsWith(base)) return null;
  return match[1];
}

function fileFor(mint: string): string {
  if (!SOLANA_ADDRESS_RE.test(mint)) throw new Error(`Invalid mint ${mint}`);
  return path.join(ROOT, `${mint}.json`);
}

/** Builds the JSON document for a coin (pure). */
export function buildTokenMetadata(input: {
  name: string;
  ticker: string;
  description: string;
  imageUrl: string;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
}): TokenMetadata {
  const image = absoluteUrl(input.imageUrl);
  const extensions: NonNullable<TokenMetadata["extensions"]> = {};
  if (input.website) extensions.website = input.website;
  if (input.twitter) extensions.twitter = input.twitter;
  if (input.telegram) extensions.telegram = input.telegram;
  return {
    name: input.name,
    symbol: input.ticker,
    description: input.description,
    image,
    external_url: input.website || absoluteUrl("/"),
    extensions,
    properties: {
      files: [{ uri: image, type: image.endsWith(".png") ? "image/png" : "image/webp" }],
      category: "image",
    },
  };
}

export async function saveTokenMetadata(mint: string, meta: TokenMetadata): Promise<void> {
  await ensureMetaDir();
  await fs.writeFile(fileFor(mint), JSON.stringify(meta, null, 2));
}

export async function readTokenMetadata(mint: string): Promise<TokenMetadata | null> {
  try {
    return JSON.parse(await fs.readFile(fileFor(mint), "utf8")) as TokenMetadata;
  } catch {
    return null;
  }
}

/** The coin fields our storage keeps, extracted from a metadata document (pure). */
export function coinFieldsFromMetadata(meta: TokenMetadata): {
  description: string;
  imageUrl: string;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
} {
  return {
    description: meta.description ?? "",
    imageUrl: meta.image ?? "",
    website: meta.extensions?.website ?? null,
    twitter: meta.extensions?.twitter ?? null,
    telegram: meta.extensions?.telegram ?? null,
  };
}
