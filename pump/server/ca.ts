import { randomBytes } from "crypto";
import bs58 from "bs58";

/**
 * Platform contract addresses look like Solana mints (44 base58 chars) and always
 * end in the lowercase suffix "noxia". They are derived from 32 random bytes and
 * generated instantly — no on-chain grinding involved.
 */
export const CA_SUFFIX = "noxia";
export const CA_LENGTH = 44;

export function generateCa(): string {
  // 32 random bytes encode to 43–44 base58 chars; pad/trim the prefix so the total is 44.
  let body = bs58.encode(randomBytes(32));
  const prefixLen = CA_LENGTH - CA_SUFFIX.length;
  while (body.length < prefixLen) body += bs58.encode(randomBytes(8));
  return body.slice(0, prefixLen) + CA_SUFFIX;
}

export function isValidCa(ca: string): boolean {
  if (ca.length !== CA_LENGTH || !ca.endsWith(CA_SUFFIX)) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(ca);
}
