import { Keypair } from "@solana/web3.js";
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha512";
import { HDNodeWallet, Mnemonic } from "ethers";

/**
 * The wallet an account gets for free.
 *
 * Signing up is enough to have somewhere to receive funds and something to sign
 * with: a BIP-39 phrase is generated in the browser, kept in this browser only,
 * and never sent anywhere — the server sees addresses and signed transactions,
 * never the phrase or a key. That is what keeps Next non-custodial while removing
 * the "install a wallet extension first" wall.
 *
 * The same phrase produces the Solana account (SLIP-0010, m/44'/501'/0'/0' — the
 * path Phantom and Solflare use, so it imports cleanly) and one EVM account
 * (m/44'/60'/0'/0/0) that serves every EVM network we accept deposits on.
 *
 * The trade-off is honest and worth stating in the UI: whoever can read this
 * browser's storage can spend the funds, and clearing site data without having
 * written the phrase down loses them.
 */

const VAULT_KEY = "nx_wallet_v1";
/** Phantom/Solflare's account path — same phrase, same address, so the seed imports cleanly. */
const SOLANA_PATH = "m/44'/501'/0'/0'";
const EVM_PATH = "m/44'/60'/0'/0/0";

export interface Vault {
  mnemonic: string;
  /** Cached so the UI can show the address without re-deriving on every render. */
  solana: string;
  evm: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// SLIP-0010 (ed25519): only hardened derivation exists for this curve
// ---------------------------------------------------------------------------

function hardenedChild(key: Uint8Array, chainCode: Uint8Array, index: number): { key: Uint8Array; chainCode: Uint8Array } {
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0;
  data.set(key, 1);
  const hardened = (index | 0x80000000) >>> 0;
  new DataView(data.buffer).setUint32(33, hardened, false);
  const I = hmac(sha512, chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function ed25519FromSeed(seed: Uint8Array, path: string): Uint8Array {
  const I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);
  for (const segment of path.split("/").slice(1)) {
    const index = Number.parseInt(segment.replace(/'$/, ""), 10);
    if (!Number.isInteger(index)) throw new Error(`bad derivation path: ${path}`);
    ({ key, chainCode } = hardenedChild(key, chainCode, index));
  }
  return key;
}

function seedOf(mnemonic: string): Uint8Array {
  const phrase = Mnemonic.fromPhrase(mnemonic.trim().toLowerCase().replace(/\s+/g, " "));
  // ethers returns "0x…"; web3.js wants bytes.
  const hex = phrase.computeSeed().slice(2);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export function solanaKeypair(mnemonic: string): Keypair {
  return Keypair.fromSeed(ed25519FromSeed(seedOf(mnemonic), SOLANA_PATH));
}

export function evmAddress(mnemonic: string): string {
  return HDNodeWallet.fromPhrase(mnemonic.trim().toLowerCase().replace(/\s+/g, " "), undefined, EVM_PATH).address;
}

export function isValidMnemonic(phrase: string): boolean {
  try {
    Mnemonic.fromPhrase(phrase.trim().toLowerCase().replace(/\s+/g, " "));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function loadVault(): Vault | null {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Vault>;
    if (typeof parsed.mnemonic !== "string" || !isValidMnemonic(parsed.mnemonic)) return null;
    // Addresses are re-derived when the stored copy is missing or from an older shape.
    const solana = parsed.solana ?? solanaKeypair(parsed.mnemonic).publicKey.toBase58();
    const evm = parsed.evm ?? evmAddress(parsed.mnemonic);
    return { mnemonic: parsed.mnemonic, solana, evm, createdAt: parsed.createdAt ?? new Date().toISOString() };
  } catch {
    return null;
  }
}

function saveVault(vault: Vault): Vault {
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  } catch {
    /* private mode: the wallet lives for this session only */
  }
  return vault;
}

function vaultFromMnemonic(mnemonic: string): Vault {
  const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  return {
    mnemonic: phrase,
    solana: solanaKeypair(phrase).publicKey.toBase58(),
    evm: evmAddress(phrase),
    createdAt: new Date().toISOString(),
  };
}

/** The browser's wallet, created on first use. */
export function ensureVault(): Vault {
  const existing = loadVault();
  if (existing) return existing;
  const phrase = Mnemonic.fromEntropy(crypto.getRandomValues(new Uint8Array(16))).phrase;
  return saveVault(vaultFromMnemonic(phrase));
}

/** Replaces this browser's wallet with the one the phrase describes. */
export function importVault(mnemonic: string): Vault {
  if (!isValidMnemonic(mnemonic)) throw new Error("That recovery phrase is not valid.");
  return saveVault(vaultFromMnemonic(mnemonic));
}

export function clearVault(): void {
  try {
    localStorage.removeItem(VAULT_KEY);
  } catch {
    /* nothing to clear */
  }
}
