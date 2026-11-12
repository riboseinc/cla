import { b64UrlEncode } from "./oidc";

/**
 * Portal sessions: HMAC-signed cookies (the estate binding pattern).
 * No server-side session store — the cookie carries its own truth,
 * integrity-protected, exp-bounded. CSRF via the double-submit
 * pattern (a csrf token in the cookie AND the form).
 */

const encoder = new TextEncoder();

export const SESSION_COOKIE = "cla_session";
export const CSRF_COOKIE = "cla_csrf";
/** Signing sessions are short-lived by design (docs/design.md §4). */
export const SESSION_TTL_SECONDS = 60 * 60 * 8;

export type SessionClaims = {
  v: 1;
  sub: string; // Ribose ID subject
  login: string; // verified GitHub handle (lowercase)
  githubId: number;
  email?: string;
  emailVerified?: boolean;
  exp: number; // unix seconds
};

async function hmac(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(content));
  return b64UrlEncode(new Uint8Array(sig));
}

const timingSafeEq = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export async function makeSessionCookie(secret: string, claims: Omit<SessionClaims, "v" | "exp">, now: number): Promise<string> {
  const payload: SessionClaims = { v: 1, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS, ...claims };
  const body = b64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function readSessionCookie(secret: string, cookie: string | undefined, now: number): Promise<SessionClaims | undefined> {
  if (!cookie) return undefined;
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!timingSafeEq(sig, await hmac(secret, body))) return undefined;
  try {
    const claims = JSON.parse(new TextDecoder().decode(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64"))) as SessionClaims;
    if (claims.v !== 1 || typeof claims.exp !== "number" || claims.exp * 1000 <= now) return undefined;
    if (typeof claims.sub !== "string" || typeof claims.login !== "string") return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

/** One-time binding state for the dual OAuth dance (signed, short-lived). */
export async function makeStateCookie(secret: string, value: Record<string, string>, now: number): Promise<string> {
  const payload = { ...value, exp: Math.floor(now / 1000) + 600 };
  const body = b64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function readStateCookie(secret: string, cookie: string | undefined, now: number): Promise<Record<string, string> | undefined> {
  const claims = await readSessionCookiePartial(secret, cookie, now);
  return claims;
}

async function readSessionCookiePartial(secret: string, cookie: string | undefined, now: number): Promise<Record<string, string> | undefined> {
  if (!cookie) return undefined;
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!timingSafeEq(sig, await hmac(secret, body))) return undefined;
  try {
    const claims = JSON.parse(new TextDecoder().decode(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64"))) as Record<string, unknown>;
    if (typeof claims["exp"] !== "number" || (claims["exp"] as number) * 1000 <= now) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(claims)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return undefined;
  }
}

export function newCsrfToken(): string {
  return b64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}
