import type { CookieOptions, NextFunction, Request, Response } from "express";
import { createHash, randomBytes } from "crypto";
import { SignJWT, createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import type { User } from "@shared/schema";
import { storage, HttpError } from "./storage";
import { config } from "./config";
import { log } from "./vite";

/**
 * Authentication primitives.
 *
 *  - Sessions are stateless HS256 JWTs (jose) carried in an httpOnly cookie.
 *    The token only contains the user id; the user record itself is always
 *    re-read from storage so profile/admin/balance changes apply immediately.
 *  - Google / Apple sign-in: the browser obtains an ID token from the identity
 *    provider and posts it to us. We verify the signature against the
 *    provider's published JWKS plus issuer + audience before trusting any claim.
 *  - Magic links: single-use, 15 minute tokens kept in memory (hashed).
 *
 * `req.user` is populated by the integrator's middleware using
 * `getUserFromRequest`; `requireAuth` / `requireAdmin` only inspect it.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Signed-in user, set by the session middleware for every /api request. */
      user?: User;
    }
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "fs_session";

/** Session lifetime: 30 days. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const SESSION_ISSUER = "foresight";

/** Raw HMAC key derived from the configured secret (jose wants bytes). */
const sessionKey = new TextEncoder().encode(config.sessionSecret);

if (config.sessionSecretIsEphemeral) {
  log("WARNING: SESSION_SECRET is not set - sessions will be invalidated on every restart", "auth");
}

/** Cookie attributes shared by set + clear so the browser matches the same cookie. */
function sessionCookieAttributes(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProd,
    path: "/",
  };
}

/** Sign a 30 day session JWT whose subject is the user id. */
export async function createSessionToken(userId: number): Promise<string> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`Cannot create a session for invalid user id ${userId}`);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(String(userId))
    .setIssuer(SESSION_ISSUER)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + SESSION_TTL_SECONDS)
    .sign(sessionKey);
}

/** Returns the user id encoded in a valid, unexpired session token, or null. */
export async function verifySessionToken(token: string): Promise<number | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey, {
      algorithms: ["HS256"],
      issuer: SESSION_ISSUER,
    });
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    return userId;
  } catch {
    // Expired, tampered, signed with a previous secret, malformed... all mean "not signed in".
    return null;
  }
}

/** Issue a session token for the user and attach it as an httpOnly cookie. */
export async function setSessionCookie(res: Response, userId: number): Promise<void> {
  const token = await createSessionToken(userId);
  res.cookie(SESSION_COOKIE, token, { ...sessionCookieAttributes(), maxAge: SESSION_TTL_MS });
}

/** Remove the session cookie (logout). */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieAttributes());
}

/**
 * Minimal Cookie header parser used only as a fallback when cookie-parser is
 * not mounted in front of us (e.g. during tests). cookie-parser populates
 * `req.cookies`, which is the preferred source.
 */
function readCookie(req: Request, name: string): string | undefined {
  const parsed = req.cookies as Record<string, unknown> | undefined;
  if (parsed && typeof parsed === "object") {
    const value = parsed[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Resolve the signed-in user for a request from its session cookie. */
export async function getUserFromRequest(req: Request): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const userId = await verifySessionToken(token);
  if (userId === null) return null;
  // `await` is harmless on the synchronous storage API and keeps this working
  // should getUser ever become async.
  const user = await storage.getUser(userId);
  return user ?? null;
}

/** Express guard: 401 unless the session middleware attached a user. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ message: "Sign in required" });
    return;
  }
  next();
}

/** Express guard: 401 when signed out, 403 unless the user is an admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ message: "Sign in required" });
    return;
  }
  if (!req.user.isAdmin) {
    res.status(403).json({ message: "Admin only" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// OpenID Connect ID tokens (Google, Apple)
// ---------------------------------------------------------------------------

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

/**
 * Remote key sets are created lazily and cached for the process lifetime:
 * jose caches the fetched keys internally and refreshes them when it sees an
 * unknown key id, so one instance per provider is the intended usage.
 */
let googleJwks: RemoteJwks | null = null;
let appleJwks: RemoteJwks | null = null;

function getGoogleJwks(): RemoteJwks {
  googleJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return googleJwks;
}

function getAppleJwks(): RemoteJwks {
  appleJwks ??= createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  return appleJwks;
}

/** Normalises an email claim: trimmed + lower-cased, or null when unusable. */
function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

/** Providers encode `email_verified` as a boolean or the string "true"/"false". */
function claimIsTrue(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Translate a jose verification failure into an HttpError with a message a
 * user (or the developer wiring up OAuth) can act on. Never leaks the token.
 */
function idTokenError(provider: "Google" | "Apple", err: unknown): HttpError {
  if (err instanceof joseErrors.JWTExpired) {
    return new HttpError(400, `Your ${provider} sign-in expired. Please try again.`);
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === "aud") {
      return new HttpError(
        400,
        `This ${provider} token was issued for a different app. Check that the client id used in the browser matches the server configuration.`,
      );
    }
    if (err.claim === "iss") {
      return new HttpError(400, `This token was not issued by ${provider}.`);
    }
    return new HttpError(400, `${provider} token rejected: ${err.reason || err.claim}.`);
  }
  if (err instanceof joseErrors.JWKSTimeout) {
    return new HttpError(503, `Timed out contacting ${provider} to verify your sign-in. Please try again.`);
  }
  if (
    err instanceof joseErrors.JWKSNoMatchingKey ||
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWSInvalid ||
    err instanceof joseErrors.JWTInvalid ||
    err instanceof joseErrors.JOSEError
  ) {
    return new HttpError(400, `Invalid ${provider} sign-in token.`);
  }
  // Anything else is almost certainly a network failure while fetching the JWKS.
  const message = err instanceof Error ? err.message : String(err);
  log(`${provider} ID token verification failed: ${message}`, "auth");
  return new HttpError(503, `Could not reach ${provider} to verify your sign-in. Please try again.`);
}

/**
 * Verify a Google ID token (from Google Identity Services) and return the
 * verified identity. Throws HttpError 503 when Google sign-in is not
 * configured and 400 when the token is invalid or the email is unverified.
 */
export async function verifyGoogleIdToken(credential: string): Promise<{ email: string; name?: string; sub: string }> {
  const clientId = config.google.clientId;
  if (!clientId) {
    throw new HttpError(503, "Google sign-in is not configured on this server (set GOOGLE_CLIENT_ID).");
  }
  if (typeof credential !== "string" || credential.length === 0) {
    throw new HttpError(400, "Missing Google credential.");
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(credential, getGoogleJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
      algorithms: ["RS256"],
    }));
  } catch (err) {
    throw idTokenError("Google", err);
  }

  const sub = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  if (!sub) throw new HttpError(400, "Invalid Google token: missing subject.");

  const email = normalizeEmail(payload.email);
  if (!email) throw new HttpError(400, "Google did not share an email address for this account.");
  if (!claimIsTrue(payload.email_verified)) {
    throw new HttpError(400, "Your Google account's email address is not verified.");
  }

  const rawName = payload.name;
  const name = typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : undefined;

  return { email, name, sub };
}

/**
 * Apple only includes the email claim in the ID token the first time a user
 * authorises the app (or after they revoke and re-authorise). We remember the
 * verified sub -> email mapping so later logins can be matched to the same
 * account. This cache is in-memory only; if it is lost the user is asked to
 * re-authorise, which makes Apple send the email again.
 */
const appleEmailBySub = new Map<string, string>();

/**
 * Verify an Apple ID token (from Sign in with Apple JS) and return the
 * verified identity. Throws HttpError 503 when Apple sign-in is not configured
 * and 400 when the token is invalid or no email can be determined.
 */
export async function verifyAppleIdToken(credential: string): Promise<{ email: string; sub: string }> {
  const clientId = config.apple.clientId;
  if (!clientId) {
    throw new HttpError(503, "Apple sign-in is not configured on this server (set APPLE_CLIENT_ID).");
  }
  if (typeof credential !== "string" || credential.length === 0) {
    throw new HttpError(400, "Missing Apple credential.");
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(credential, getAppleJwks(), {
      issuer: APPLE_ISSUER,
      audience: clientId,
      algorithms: ["RS256"],
    }));
  } catch (err) {
    throw idTokenError("Apple", err);
  }

  const sub = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  if (!sub) throw new HttpError(400, "Invalid Apple token: missing subject.");

  // Prefer the email in the token; fall back to what we saw on a previous login.
  const tokenEmail = normalizeEmail(payload.email);
  if (tokenEmail) {
    // Apple sets email_verified for every email it hands out (relay addresses included);
    // reject only when it is explicitly false.
    if (payload.email_verified !== undefined && !claimIsTrue(payload.email_verified)) {
      throw new HttpError(400, "Your Apple ID email address is not verified.");
    }
    appleEmailBySub.set(sub, tokenEmail);
    return { email: tokenEmail, sub };
  }

  const cached = appleEmailBySub.get(sub);
  if (cached) return { email: cached, sub };

  // Last resort: an existing account may have been created with this Apple sub
  // earlier but our in-memory cache was lost. Nothing else identifies the user,
  // so ask them to re-authorise (Apple resends the email after revocation).
  throw new HttpError(
    400,
    "Apple did not share your email address. Go to Settings > Apple ID > Sign in with Apple, remove this app, then sign in again.",
  );
}

// ---------------------------------------------------------------------------
// Magic links
// ---------------------------------------------------------------------------

/** Magic link lifetime: 15 minutes. */
const MAGIC_TOKEN_TTL_MS = 15 * 60 * 1000;

interface MagicTokenRecord {
  email: string;
  expiresAt: number;
}

/**
 * Only the SHA-256 hash of each token is kept, so a memory dump / log of this
 * map cannot be used to sign in. Tokens are single-use and live in memory:
 * a restart simply invalidates outstanding links, which is acceptable for a
 * 15 minute window.
 */
const magicTokens = new Map<string, MagicTokenRecord>();

function hashMagicToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function purgeExpiredMagicTokens(now: number): void {
  // Deleting the current entry inside Map#forEach is well-defined in ECMAScript.
  magicTokens.forEach((record, hash) => {
    if (record.expiresAt <= now) magicTokens.delete(hash);
  });
}

/** Create a single-use sign-in token for the email and remember its hash. */
export function createMagicToken(email: string): string {
  const now = Date.now();
  purgeExpiredMagicTokens(now);
  const normalized = normalizeEmail(email);
  if (!normalized) throw new HttpError(400, "A valid email address is required.");
  const token = randomBytes(32).toString("base64url");
  magicTokens.set(hashMagicToken(token), { email: normalized, expiresAt: now + MAGIC_TOKEN_TTL_MS });
  return token;
}

/**
 * Redeem a magic token. Returns the email exactly once; the token is deleted
 * whether or not it was still valid. Returns null when unknown or expired.
 */
export function consumeMagicToken(token: string): string | null {
  const now = Date.now();
  purgeExpiredMagicTokens(now);
  if (typeof token !== "string" || token.length === 0) return null;
  const hash = hashMagicToken(token);
  const record = magicTokens.get(hash);
  if (!record) return null;
  magicTokens.delete(hash);
  if (record.expiresAt <= now) return null;
  return record.email;
}

/** Absolute URL the user clicks in the email (or in the dev-mode UI). */
export function buildMagicLink(token: string): string {
  const base = config.appUrl.replace(/\/+$/, "");
  return `${base}/api/auth/verify?token=${encodeURIComponent(token)}`;
}
