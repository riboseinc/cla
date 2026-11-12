import { b64UrlEncode } from "./oidc";

/**
 * Signed completion-link tokens for the comment-command flow
 * (docs/design.md §3.12): `@ribose-cla agree` -> the bot replies with
 * `/icla/complete?t=<token>`; the token binds (repo, pr, login) for
 * 10 minutes and the portal only completes the signature when the
 * freshly-proven handle equals the token's login.
 */

const encoder = new TextEncoder();

export type CompletionToken = {
  repo: string;
  pr: number;
  login: string;
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

export async function signCompletionToken(secret: string, data: { repo: string; pr: number; login: string }, now: number): Promise<string> {
  const payload: CompletionToken = { ...data, exp: Math.floor(now / 1000) + 600 };
  const body = b64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function readCompletionToken(secret: string, token: string | undefined, now: number): Promise<CompletionToken | undefined> {
  if (!token) return undefined;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEq(sig, await hmac(secret, body))) return undefined;
  try {
    const claims = JSON.parse(new TextDecoder().decode(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64"))) as CompletionToken;
    if (claims.exp * 1000 <= now) return undefined;
    if (typeof claims.repo !== "string" || typeof claims.pr !== "number" || typeof claims.login !== "string") return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

/** The exact command (case-insensitive, trimmed). */
export const AGREE_COMMAND = "@ribose-cla agree";
export const isAgreeCommand = (body: string): boolean => body.trim().toLowerCase() === AGREE_COMMAND;
