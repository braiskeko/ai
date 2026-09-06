import { randomBytes } from "crypto";

/**
 * All runtime configuration lives here and comes from environment variables.
 *
 * Next is a non-custodial Solana launchpad: the server never holds keys for
 * user funds. The only chain-related secrets it may hold are the pre-mined
 * vanity MINT keypairs (VANITY_DIR), which are one-shot, never funded and only
 * ever co-sign the pool creation transaction the user themselves signs.
 */

const env = (k: string, fallback = ""): string => process.env[k]?.trim() || fallback;

export type Cluster = "mainnet-beta" | "devnet";

const cluster: Cluster = env("SOLANA_CLUSTER", "mainnet-beta") === "devnet" ? "devnet" : "mainnet-beta";

const defaultRpcUrl = cluster === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
const rpcUrl = env("RPC_URL", defaultRpcUrl);

/** wss endpoint derived from the http one when RPC_WS_URL is not given (what web3.js does by default). */
function deriveWsUrl(http: string): string | null {
  try {
    const url = new URL(http);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export const config = {
  appName: env("APP_NAME", "Next"),
  /** Public URL of the deployment: magic-link emails and absolute metadata URLs. */
  appUrl: env("APP_URL", `http://localhost:${env("PORT", "5000")}`),
  port: Number(env("PORT", "5000")),
  isProd: process.env.NODE_ENV === "production",

  /** Secret used to sign session cookies. Random per boot if unset (sessions won't survive restarts). */
  sessionSecret: env("SESSION_SECRET") || randomBytes(32).toString("hex"),
  sessionSecretIsEphemeral: !env("SESSION_SECRET"),

  /** Comma separated list of admin emails. */
  adminEmails: env("ADMIN_EMAILS")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  google: { clientId: env("GOOGLE_CLIENT_ID") || null },
  apple: { clientId: env("APPLE_CLIENT_ID") || null },

  /** Directory for uploaded coin images / comment attachments. */
  uploadsDir: env("UPLOADS_DIR", "data/uploads"),
  /** Directory holding the Metaplex metadata JSON we serve at /api/meta/<mint>.json. */
  metaDir: env("META_DIR", "data/meta"),
  /** Directory holding pre-mined vanity mint keypairs ({publicKey, secretKey} JSON files). */
  vanityDir: env("VANITY_DIR", "data/vanity"),

  email: {
    resendApiKey: env("RESEND_API_KEY") || null,
    from: env("EMAIL_FROM", "Next <onboarding@resend.dev>"),
  },
  /**
   * Pre-launch mode: signing in with an email creates the account and the session
   * immediately, with no verification link or code. Set INSTANT_EMAIL_LOGIN=0 to
   * require the magic link before going live.
   */
  instantEmailLogin: env("INSTANT_EMAIL_LOGIN", "1") !== "0",
  /**
   * Fabricate a handful of fake coins for offline UI work. Never on mainnet, never
   * when a real DBC config is configured. Off by default everywhere.
   */
  seedDemo: env("SEED_DEMO", "0") !== "0",

  solana: {
    cluster,
    testnet: cluster !== "mainnet-beta",
    rpcUrl,
    rpcWsUrl: env("RPC_WS_URL") || deriveWsUrl(rpcUrl),
    /** Meteora Dynamic Bonding Curve partner config Next launches through (base58). */
    dbcConfig: env("DBC_CONFIG") || null,
    /** Wallet that receives the platform share of every swap fee (the config's feeClaimer). */
    treasuryWallet: env("TREASURY_WALLET") || null,
    /** Used until the first successful CoinGecko response (and whenever it fails). */
    solUsdFallback: Number(env("SOL_USD_FALLBACK", "150")) || 150,
    explorer: "https://solscan.io",
  },

  /** Bearer token for the vanity-key uploader (`x-admin-token` header). */
  adminApiToken: env("ADMIN_API_TOKEN") || null,

  /** Postgres connection string (Neon works). Falls back to a JSON file when unset. */
  databaseUrl: env("DATABASE_URL") || null,
  dataFile: env("DATA_FILE", "data/state.json"),
};

export type Config = typeof config;
