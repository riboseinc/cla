import type { AgreementRef } from "@riboseinc/cla-kernel";
import { b64UrlEncode } from "./oidc";

/**
 * Signed attribution-link tokens (docs/design.md §3.11): the bot's
 * must-specify links carry an HMAC-signed token binding the (repo, pr,
 * login, options) tuple — the portal verifies it and requires the
 * session login to equal the token's login, so only the committer can
 * elect the agreement. 10-minute expiry.
 */

const encoder = new TextEncoder();

export type AttributionToken = {
  repo: string;
  pr: number;
  login: string;
  /** the PR repo's installation — carried so the portal can re-check without lookups */
  installationId: number;
  options: AgreementRef[];
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

export function optionKey(ref: AgreementRef): string {
  return ref.kind === "ocla" ? `ocla:${ref.oclaId}` : ref.kind;
}

export async function signAttributionToken(secret: string, data: { repo: string; pr: number; login: string; installationId: number; options: AgreementRef[] }, now: number): Promise<string> {
  const payload: AttributionToken = { ...data, exp: Math.floor(now / 1000) + 600 };
  const body = b64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function readAttributionToken(secret: string, token: string | undefined, now: number): Promise<AttributionToken | undefined> {
  if (!token) return undefined;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEq(sig, await hmac(secret, body))) return undefined;
  try {
    const claims = JSON.parse(new TextDecoder().decode(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64"))) as AttributionToken;
    if (claims.exp * 1000 <= now) return undefined;
    if (typeof claims.repo !== "string" || typeof claims.pr !== "number" || typeof claims.login !== "string" || !Array.isArray(claims.options)) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}
