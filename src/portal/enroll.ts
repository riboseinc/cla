import { b64UrlEncode } from "./oidc";

/**
 * PoC enrollment tokens (docs/design.md §4): issued when an OCLA is
 * executed (and by staff for backfilled agreements) — the invited
 * email must end up VERIFIED on the claimant's identity account
 * before org_admin is granted. Single-use semantics come from the
 * one-pending-per-account/org record; the token itself is
 * email-bound, 14-day expiry.
 */

const encoder = new TextEncoder();

export type EnrollmentToken = {
  kind: "enroll";
  oclaId: string;
  email: string;
  exp: number;
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

export async function signEnrollmentToken(secret: string, oclaId: string, email: string, now: number): Promise<string> {
  const payload: EnrollmentToken = { kind: "enroll", oclaId, email: email.toLowerCase(), exp: Math.floor(now / 1000) + 14 * 24 * 3600 };
  const body = b64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function readEnrollmentToken(secret: string, token: string | undefined, now: number): Promise<EnrollmentToken | undefined> {
  if (!token) return undefined;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEq(sig, await hmac(secret, body))) return undefined;
  try {
    const claims = JSON.parse(new TextDecoder().decode(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64"))) as EnrollmentToken;
    if (claims.kind !== "enroll" || claims.exp * 1000 <= now) return undefined;
    if (typeof claims.oclaId !== "string" || typeof claims.email !== "string") return undefined;
    return claims;
  } catch {
    return undefined;
  }
}
