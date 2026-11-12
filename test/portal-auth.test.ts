import { describe, expect, it, beforeEach } from "vitest";
import { createApp, resetOidcCaches } from "../src/app";
import { makeSessionCookie, readSessionCookie, SESSION_COOKIE } from "../src/portal/session";
import { derSignatureToRawEs256 } from "../src/portal/oidc";
import { makeFixture, makeKeyPem, type Fixture } from "./helpers";
import { GENERATED_CONFIG } from "../src/generated/config";

/**
 * A real local OP: real EC P-256 keypair, real JWS signing (both raw
 * and DER postures — the identity service mints DER), real discovery
 * + JWKS + token endpoints. The dual flow is driven end-to-end
 * through app.fetch.
 */

const ISSUER = GENERATED_CONFIG.identity.issuer;
const CLIENT_ID = GENERATED_CONFIG.identity.clientId;
const PORTAL = `https://${GENERATED_CONFIG.instance.portalHost}`;

type OpKeys = { private: CryptoKey; jwk: JsonWebKey };

async function makeOpKeys(): Promise<OpKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { private: pair.privateKey, jwk };
}

async function mintIdToken(keys: OpKeys, claims: Record<string, unknown>, posture: "raw" | "der"): Promise<string> {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "ES256", kid: "k1" });
  const payload = enc(claims);
  const signed = new TextEncoder().encode(`${header}.${payload}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.private, signed));
  const wire = posture === "raw" ? sig : rawToDer(sig);
  return `${header}.${payload}.${Buffer.from(wire).toString("base64url")}`;
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const half = (v: Uint8Array): Uint8Array => {
    let s = 0;
    while (s < v.length - 1 && v[s] === 0) s++;
    let e = v.length;
    while (e > 1 && v[e - 1] === 0) e--;
    const core = v.slice(s, e);
    return core[0]! & 0x80 ? new Uint8Array([0x00, ...core]) : core;
  };
  const r = half(raw.slice(0, 32));
  const s = half(raw.slice(32));
  const len = r.length + s.length + 4;
  return new Uint8Array([0x30, len, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}

function opFixture(fx: Fixture, keys: OpKeys, token: string): void {
  fx.routes.set("/.well-known/openid-configuration", () =>
    Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks.json` }, { status: 200 }),
  );
  fx.routes.set("/token", () => Response.json({ id_token: token }, { status: 200 }));
  fx.routes.set("/jwks.json", () =>
    Response.json({ keys: [{ ...keys.jwk, kid: "k1", alg: "ES256", use: "sig" }] }, { status: 200 }),
  );
}

const GITHUB_TOKEN = "ghu_browser";
const GH_USER = { login: "tj-91", id: 918273 };

function githubFixture(fx: Fixture): void {
  fx.routes.set("/login/oauth/access_token", () => Response.json({ access_token: GITHUB_TOKEN, token_type: "bearer" }, { status: 200 }));
  fx.routes.set("/user", () => Response.json(GH_USER, { status: 200 }));
}

const ENV = (pem: string) => ({ OIDC_CLIENT_SECRET: "op-secret", GITHUB_APP_CLIENT_ID: "Iv1.client", GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem });

function cookieOf(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0]?.split("=").slice(1).join("=");
}

describe("portal auth: the dual flow", () => {
  let pem: string;
  let keys: OpKeys;
  let fx: Fixture;

  beforeEach(async () => {
    pem = await makeKeyPem();
    keys = await makeOpKeys();
    fx = makeFixture();
    githubFixture(fx);
    const claims = {
      iss: ISSUER, aud: CLIENT_ID, sub: "ribose-sub-1", exp: Math.floor(Date.now() / 1000) + 600,
      email: "tj@mtg.example", email_verified: true, auth_time: Math.floor(Date.now() / 1000),
    };
    opFixture(fx, keys, await mintIdToken(keys, claims, "der")); // the estate mints DER
    resetOidcCaches();
  });

  it("github round: authorize redirect -> callback exchanges and redirects to the identity round", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    const r1 = await app.request("/signin/github");
    expect(r1.status).toBe(302);
    expect(r1.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    expect(r1.headers.get("set-cookie")).toContain("cla_flow=");

    const cb = new URL(r1.headers.get("location")!);
    const r2 = await app.request(`/callback/github?code=abc&state=${cb.searchParams.get("state")}`, { headers: { cookie: `cla_flow=${cookieOf(r1, "cla_flow")}` } });
    expect(r2.status).toBe(302);
    expect(r2.headers.get("location")).toContain(`${ISSUER}/authorize`);
    const authUrl = new URL(r2.headers.get("location")!);
    expect(authUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("scope")).toBe("openid email");
    const flowCookie = cookieOf(r2, "cla_flow")!;
    const flowPayload = Buffer.from(flowCookie.split(".")[0]!, "base64url").toString();
    expect(flowPayload).toContain("ghLogin"); // handle carried forward, signed
    const tokenCall = fx.calls.find((c) => c.url === "https://github.com/login/oauth/access_token");
    expect(new URLSearchParams(tokenCall!.body as string).get("client_secret")).toBe("op-secret");
  });

  it("full dual flow: both identities proven -> LINK record written + session established", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    const r1 = await app.request("/signin/github");
    const cb = new URL(r1.headers.get("location")!);
    const r2 = await app.request(`/callback/github?code=abc&state=${cb.searchParams.get("state")}`, { headers: { cookie: `cla_flow=${cookieOf(r1, "cla_flow")}` } });
    const authUrl = new URL(r2.headers.get("location")!);
    const r3 = await app.request(`/callback/ribose?code=oidc-code&state=${authUrl.searchParams.get("state")}`, { headers: { cookie: `cla_flow=${cookieOf(r2, "cla_flow")}` } });

    expect(r3.status).toBe(302);
    expect(r3.headers.get("location")).toBe(`${PORTAL}/agreements`);
    const session = cookieOf(r3, SESSION_COOKIE);
    expect(session).toBeDefined();

    // the LINK record landed in the data repo
    const put = fx.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/link/"));
    expect(put).toBeDefined();
    const record = JSON.parse(Buffer.from((put!.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>;
    expect(record).toMatchObject({ ribose_id_sub: "ribose-sub-1", github_login: "tj-91", github_id: GH_USER.id, source: "portal-dual-flow" });

    // the session proves the binding
    const r4 = await app.request("/agreements", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
    expect(r4.status).toBe(200);
    const body4 = (await r4.json()) as Record<string, unknown>;
    expect(body4["bound"]).toEqual({ ribose_id_sub: "ribose-sub-1", github_login: "tj-91", github_id: GH_USER.id });
    expect(body4["email_verified"]).toBe(true);
  });

  it("fail-closed: state cookie tampering -> 400", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    const r = await app.request("/callback/github?code=abc&state=whatever", { headers: { cookie: "cla_flow=tampered.junk" } });
    expect(r.status).toBe(400);
  });

  it("fail-closed: no identity secret -> the whole portal does not exist", async () => {
    const app = createApp({ GITHUB_APP_CLIENT_ID: "Iv1.client" }, { fetcher: fx.fetcher });
    expect((await app.request("/signin/github")).status).toBe(404);
    expect((await app.request("/agreements")).status).toBe(404);
  });

  it("fail-closed: unauthenticated /agreements -> 401", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    expect((await app.request("/agreements")).status).toBe(401);
  });
});

describe("session cookie mechanics", () => {
  it("round-trips and rejects tampering + expiry", async () => {
    const secret = "s3cret";
    const now = 1_000_000_000_000;
    const cookie = await makeSessionCookie(secret, { sub: "s1", login: "a", githubId: 1 }, now);
    const ok = await readSessionCookie(secret, cookie, now);
    expect(ok).toMatchObject({ sub: "s1", login: "a" });
    expect(await readSessionCookie(secret, cookie.replace(/.$/, "x"), now)).toBeUndefined();
    expect(await readSessionCookie(secret, cookie, now + 9 * 3600 * 1000)).toBeUndefined();
    expect(await readSessionCookie("other", cookie, now)).toBeUndefined();
  });
});

describe("DER posture", () => {
  it("derSignatureToRawEs256 normalizes DER to 64-byte raw", async () => {
    const keys = await makeOpKeys();
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = enc({ alg: "ES256", kid: "k1" });
    const payload = enc({ iss: ISSUER, aud: CLIENT_ID, sub: "s", exp: 9999999999 });
    const signed = new TextEncoder().encode(`${header}.${payload}`);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.private, signed));
    const der = rawToDer(raw);
    const normalized = derSignatureToRawEs256(der);
    expect(normalized).not.toBeNull();
    expect(normalized).toEqual(raw);
    expect(derSignatureToRawEs256(raw)).toBeNull(); // raw in, null out (already raw)
  });
});
