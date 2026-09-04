import { randomBytes } from "crypto";
import type { ChainInfo } from "@shared/schema";

/**
 * All runtime configuration lives here and comes from environment variables.
 * See .env.example for documentation of each variable.
 */

const CHAINS: Record<string, ChainInfo> = {
  polygon: {
    key: "polygon",
    name: "Polygon",
    chainId: 137,
    testnet: false,
    // Native USDC on Polygon PoS (Circle)
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    explorer: "https://polygonscan.com",
    rpcUrl: "https://polygon-rpc.com",
    confirmations: 30,
  },
  amoy: {
    key: "amoy",
    name: "Polygon Amoy (testnet)",
    chainId: 80002,
    testnet: true,
    usdcAddress: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
    explorer: "https://amoy.polygonscan.com",
    rpcUrl: "https://rpc-amoy.polygon.technology",
    confirmations: 5,
  },
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    testnet: false,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorer: "https://basescan.org",
    rpcUrl: "https://mainnet.base.org",
    confirmations: 12,
  },
  "base-sepolia": {
    key: "base-sepolia",
    name: "Base Sepolia (testnet)",
    chainId: 84532,
    testnet: true,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorer: "https://sepolia.basescan.org",
    rpcUrl: "https://sepolia.base.org",
    confirmations: 3,
  },
};

const env = (k: string, fallback = "") => process.env[k]?.trim() || fallback;

const chainKey = env("CHAIN", "amoy");
const chainBase = CHAINS[chainKey] ?? CHAINS.amoy;

export const config = {
  appName: env("APP_NAME", "Foresight"),
  /** Public URL of the deployment, used in magic-link emails. */
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

  email: {
    resendApiKey: env("RESEND_API_KEY") || null,
    from: env("EMAIL_FROM", "Foresight <onboarding@resend.dev>"),
  },

  chain: {
    ...chainBase,
    rpcUrl: env("RPC_URL") || chainBase.rpcUrl,
  } as ChainInfo,
  /** BIP-39 phrase used to derive one deposit address per user. Generated on first boot if unset. */
  depositMnemonic: env("DEPOSIT_MNEMONIC") || null,
  /** Hot wallet that pays withdrawals. Withdrawals stay "pending" when unset. */
  treasuryPrivateKey: env("TREASURY_PRIVATE_KEY") || null,
  /** Set to "0" to disable the on-chain deposit watcher (e.g. in CI). */
  depositsEnabled: env("DEPOSITS_ENABLED", "1") !== "0",

  /** Postgres connection string (Neon works). Falls back to a JSON file when unset. */
  databaseUrl: env("DATABASE_URL") || null,
  dataFile: env("DATA_FILE", "data/state.json"),
};

export type Config = typeof config;
