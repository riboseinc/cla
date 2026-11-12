/**
 * The portal's OIDC relying-party client against the estate identity
 * service. Ported from the proven Workers RP in ribosei/status
 * (discovery + JWKS isolate caches, PKCE S256, ES256 verification with
 * the DER→raw normalization for node:crypto-minting identity
 * services) — one delta: this is a CONFIDENTIAL client
 * (client_secret_post) because the portal holds a secret.
 */
export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Jwk {
  kid?: string;
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
}

export interface IdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  email?: string;
  email_verified?: boolean;
  auth_time?: number;
  [claim: string]: unknown;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function b64UrlDecodeBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64UrlDecodeJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(b64UrlDecodeBytes(input))) as T;
}

export function b64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64UrlEncode(new Uint8Array(digest));
}

const DISCOVERY_TTL_MS = 10 * 60_000;
const JWKS_TTL_MS = 10 * 60_000;
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

export function resetOidcCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

export async function discover(issuer: string, fetcher: Fetcher, now: number): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.doc;
  const res = await fetcher(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the identity service's discovery document answered ${res.status}`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer !== issuer) throw new Error(`the discovery issuer '${doc.issuer}' disagrees with the configured '${issuer}'`);
  discoveryCache.set(issuer, { at: now, doc });
  return doc;
}

async function jwks(jwksUri: string, fetcher: Fetcher, now: number): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && now - cached.at < JWKS_TTL_MS) return cached.keys;
  const res = await fetcher(jwksUri, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the identity service's JWKS answered ${res.status}`);
  const doc = (await res.json()) as { keys: Jwk[] };
  jwksCache.set(jwksUri, { at: now, keys: doc.keys });
  return doc.keys;
}

export interface AuthorizationRequest {
  url: URL;
  state: string;
  verifier: string;
}

export async function authorizationRequest(discovery: Discovery, clientId: string, redirectUri: string, random: () => string): Promise<AuthorizationRequest> {
  const verifier = b64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const state = random();
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return { url, state, verifier };
}

/** Confidential client: the exchange authenticates with client_secret_post. */
export async function exchangeCode(
  discovery: Discovery,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
  verifier: string,
  fetcher: Fetcher,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: verifier,
  });
  const res = await fetcher(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the token endpoint answered ${res.status}`);
  const doc = (await res.json()) as { id_token?: string };
  if (typeof doc.id_token !== "string" || doc.id_token === "") throw new Error("the token document carried no id_token");
  return doc.id_token;
}

export async function verifyIdToken(
  discovery: Discovery,
  idToken: string,
  expectedIssuer: string,
  expectedAudience: string,
  fetcher: Fetcher,
  now: number,
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("the id_token is not a JWS compact serialization");
  const [headerRaw, payloadRaw, signatureRaw] = parts as [string, string, string];
  const header = b64UrlDecodeJson<{ alg: string; kid?: string }>(headerRaw);
  if (header.alg !== "ES256") throw new Error(`the id_token alg '${header.alg}' is not ES256`);

  const claims = b64UrlDecodeJson<IdTokenClaims>(payloadRaw);
  if (claims.iss !== expectedIssuer) throw new Error(`the id_token issuer '${claims.iss}' disagrees with '${expectedIssuer}'`);
  if (claims.aud !== expectedAudience) throw new Error(`the id_token audience '${claims.aud}' disagrees with the client id`);
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) throw new Error("the id_token is expired");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("the id_token carries no subject");

  const keys = await jwks(discovery.jwks_uri, fetcher, now);
  const candidates = keys.filter((key) => key.kty === "EC" && key.crv === "P-256" && (header.kid === undefined || key.kid === header.kid));
  if (candidates.length === 0) throw new Error("the JWKS carries no matching P-256 key");

  const signature = b64UrlDecodeBytes(signatureRaw);
  const signed = new TextEncoder().encode(`${headerRaw}.${payloadRaw}`);
  const normalized = derSignatureToRawEs256(signature) ?? signature;
  let verified = false;
  for (const key of candidates) {
    const cryptoKey = await crypto.subtle.importKey("jwk", key as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, normalized, signed)) {
      verified = true;
      break;
    }
  }
  if (!verified) throw new Error("the id_token signature did not verify against the JWKS");
  return claims;
}

/** DER ECDSA-Sig-Value → raw r||s; null when not DER (verify as-is). */
export function derSignatureToRawEs256(signature: Uint8Array): Uint8Array | null {
  if (signature.length < 8 || signature[0] !== 0x30) return null;
  let at = 1;
  const seqLen = signature[at++]!;
  if (seqLen & 0x80) {
    const count = seqLen & 0x7f;
    if (count === 0 || count > 2) return null;
    at += count;
  }
  const readInteger = (): Uint8Array | null => {
    if (signature[at] !== 0x02) return null;
    at += 1;
    let size = signature[at++]!;
    if (size & 0x80) {
      const count = size & 0x7f;
      if (count === 0 || count > 2) return null;
      size = 0;
      for (let i = 0; i < count; i += 1) {
        const byte = signature[at++];
        if (byte === undefined) return null;
        size = size * 256 + byte;
      }
    }
    if (at + size > signature.length) return null;
    const value = signature.slice(at, at + size);
    at += size;
    return value;
  };
  const r = readInteger();
  if (r === null) return null;
  const s = readInteger();
  if (s === null) return null;
  const pad32 = (value: Uint8Array): Uint8Array | null => {
    let first = 0;
    while (first < value.length - 1 && value[first] === 0) first += 1;
    const trimmed = value.slice(first);
    return trimmed.length > 32 ? null : trimmed;
  };
  const r32 = pad32(r);
  const s32 = pad32(s);
  if (r32 === null || s32 === null) return null;
  const raw = new Uint8Array(64);
  raw.set(r32, 32 - r32.length);
  raw.set(s32, 64 - s32.length);
  return raw;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
