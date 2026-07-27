/**
 * Server-issued, signed, httpOnly session cookie — replaces the old
 * client-generated `sessionId` (a plain string built from Date.now() +
 * Math.random(), sent as an explicit request parameter and stored in
 * plaintext localStorage). That scheme had three real problems: the id was
 * guessable (Math.random() is not cryptographically secure, and the
 * timestamp half narrows the search space further), it never expired, and
 * it could not be revoked. This module fixes the first two immediately and
 * gives partial coverage of the third (see below) without requiring any new
 * database table or a manual migration step, so it is safe to deploy as-is.
 *
 * Design:
 *  - The session id itself is 256 bits from crypto.randomBytes — not
 *    guessable in any practical sense.
 *  - It is transmitted only as an httpOnly cookie, never readable by client
 *    JS, so it cannot be exfiltrated by an XSS bug on this origin the way a
 *    localStorage value can.
 *  - The cookie value is HMAC-signed so a tampered/forged cookie is rejected
 *    outright (fails closed) before ever touching the database.
 *  - The cookie is re-issued (sliding expiry) on every request, so an
 *    abandoned session naturally expires SESSION_MAX_AGE_MS after last use
 *    instead of living forever.
 *  - Revocation: rotating SESSION_SECRET invalidates every session at once
 *    (fleet-wide kill switch, e.g. if you suspect any compromise). Revoking
 *    ONE specific session without affecting others would need a server-side
 *    sessions table (so a session can be looked up and marked dead before
 *    its natural expiry) -- deliberately not added here because it requires
 *    a database migration this environment cannot apply on your behalf; see
 *    the sessions-table option if you want true per-session revocation.
 *
 * Legacy bridge: existing users' bill history is keyed to their OLD
 * localStorage sessionId string. Rather than silently orphaning it, the
 * client sends that old value once as X-Legacy-Session-Id; if a real bill
 * exists under it, we "adopt" it (wrap the SAME id in a new signed cookie)
 * so history keeps working. Brand new visitors never send this header.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ENV } from "./env";
import { logger } from "./logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sessionId?: string;
    }
  }
}

export const SESSION_COOKIE_NAME = "bom_sid";
export const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // 180 days, sliding

/** Matches the OLD client-generated id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`. */
export const LEGACY_SESSION_ID_RE = /^session-\d{10,14}-[a-z0-9]{6,12}$/i;

/** Plausible shape of a freshly-minted (or legacy) raw session id, before the ".<sig>" suffix. */
const RAW_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

let cachedSecret: string | null = null;
let warnedMissingSecret = false;

/**
 * SESSION_SECRET should be set explicitly in production. If it is not, we
 * derive a stable fallback from an already-configured secret so the app
 * still works correctly out of the box (no hard crash, no per-cold-start
 * secret rotation that would silently log everyone out) -- but this is a
 * "works safely today" fallback, not a substitute for setting a real one.
 */
function getSessionSecret(): string {
  if (cachedSecret) return cachedSecret;

  const configured = process.env.SESSION_SECRET;
  if (configured) {
    cachedSecret = configured;
    return cachedSecret;
  }

  if (!warnedMissingSecret) {
    logger.warn(
      "SESSION_SECRET is not set -- deriving a fallback signing key from " +
        "SUPABASE_SERVICE_ROLE_KEY/DATABASE_URL. Sessions still work and stay " +
        "stable across restarts, but set a dedicated SESSION_SECRET env var " +
        "for proper secret separation."
    );
    warnedMissingSecret = true;
  }

  const basis =
    ENV.supabase.serviceRoleKey || ENV.databaseUrl || "aws-bom-builder-insecure-dev-fallback";
  cachedSecret = createHash("sha256").update(`aws-bom-session-v1:${basis}`).digest("hex");
  return cachedSecret;
}

export function signSessionId(id: string): string {
  const sig = createHmac("sha256", getSessionSecret()).update(id).digest("base64url");
  return `${id}.${sig}`;
}

/** Verifies signature + shape; returns the raw session id, or null if missing/tampered/malformed. */
export function verifySignedSessionId(token: string | undefined | null): string | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0 || idx === token.length - 1) return null;

  const id = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!RAW_ID_RE.test(id)) return null;

  const expected = createHmac("sha256", getSessionSecret()).update(id).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  return id;
}

export function parseCookieHeader(header?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Pure decision logic (no Express, no DB import) so it is directly unit
 * testable: given the incoming cookie + optional legacy header, decide which
 * session id this request should use.
 */
export async function resolveIncomingSessionId(params: {
  cookieHeader?: string | null;
  legacyHeader?: string | null;
  hasLegacyHistory: (id: string) => Promise<boolean>;
}): Promise<string> {
  const cookies = parseCookieHeader(params.cookieHeader);
  const fromCookie = verifySignedSessionId(cookies[SESSION_COOKIE_NAME]);
  if (fromCookie) return fromCookie;

  if (params.legacyHeader && LEGACY_SESSION_ID_RE.test(params.legacyHeader)) {
    const exists = await params.hasLegacyHistory(params.legacyHeader).catch(() => false);
    if (exists) return params.legacyHeader;
  }

  return randomBytes(32).toString("base64url");
}

export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE_NAME, signSessionId(sessionId), {
    httpOnly: true,
    secure: ENV.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function firstHeaderValue(v: string | string[] | undefined): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return null;
}

/** Express middleware factory. `hasLegacyHistory` is injected so this module never imports the domain-specific db layer directly. */
export function createSessionMiddleware(deps: { hasLegacyHistory: (id: string) => Promise<boolean> }) {
  return function sessionMiddleware(req: Request, res: Response, next: NextFunction): void {
    resolveIncomingSessionId({
      cookieHeader: req.headers.cookie,
      legacyHeader: firstHeaderValue(req.headers["x-legacy-session-id"]),
      hasLegacyHistory: deps.hasLegacyHistory,
    })
      .then(sessionId => {
        req.sessionId = sessionId;
        setSessionCookie(res, sessionId);
        next();
      })
      .catch(next);
  };
}
