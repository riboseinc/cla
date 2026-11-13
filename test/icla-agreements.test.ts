import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { makeSessionCookie, newCsrfToken, SESSION_COOKIE, CSRF_COOKIE } from "../src/portal/session";
import { makeFixture, makeKeyPem, type Fixture } from "./helpers";
import { GENERATED_CONFIG } from "../src/generated/config";

const ENV = (pem: string) => ({
  OIDC_CLIENT_SECRET: "op-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "gh-secret",
  GITHUB_APP_ID: "1",
  APP_PRIVATE_KEY: pem,
  WEBHOOK_SECRET: "wh",
});

let pem: string;
let fx: Fixture;
let session: string;
let csrf: string;

const app = () => createApp(ENV(pem), { fetcher: fx.fetcher });
const authed = () => ({ cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}` });

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
  session = await makeSessionCookie("op-secret", { sub: "sub-1", login: "tj-91", githubId: 918273, email: "johannes@mtg.example", emailVerified: true }, Date.now());
  csrf = newCsrfToken();
});

describe("ICLA signing", () => {
  it("fail-closed: unauthenticated 401", async () => {
    expect((await app().request("/icla")).status).toBe(401);
  });

  it("the form carries the exact edition text, its hash, and BOTH required consents", async () => {
    const res = await app().request("/icla", { headers: authed() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(GENERATED_CONFIG.legal.current.icla);
    expect(html).toContain("sha256");
    expect(html).toContain("ALL my previous contributions");
    expect(html).toContain('name="terms" required');
    expect(html).toContain('name="past"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="country"');
    expect(html).toContain(`value="${csrf}"`);
  });

  it("csrf mismatch -> 403; missing terms -> 400", async () => {
    const a = app();
    expect(
      (await a.request("/icla/sign", { method: "POST", headers: authed(), body: new URLSearchParams({ terms: "on", past: "yes", csrf: "wrong" }) })).status,
    ).toBe(403);
    expect(
      (await a.request("/icla/sign", { method: "POST", headers: authed(), body: new URLSearchParams({ past: "yes", csrf }) })).status,
    ).toBe(400);
  });

  it("signing appends the record bound to the current edition with the election recorded", async () => {
    const res = await app().request("/icla/sign", {
      method: "POST",
      headers: authed(),
      body: new URLSearchParams({ terms: "on", past: "yes", csrf, name: "Johannes Roth", email: "johannes@mtg.example", country: "Germany" }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["signed"]).toBe(true);
    expect(out["past_contributions_included"]).toBe(true);

    const put = fx.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/icla/"));
    expect(put).toBeDefined();
    const record = JSON.parse(Buffer.from((put!.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>;
    expect(record).toMatchObject({
      github_login: "tj-91",
      ribose_id_sub: "sub-1",
      source: "portal",
      past_contributions_included: true,
      email_verified: true,
    });
    expect(record["claEdition"]).toEqual(GENERATED_CONFIG.legal.editions.icla.find((e) => e.version === GENERATED_CONFIG.legal.current.icla) && {
      kind: "icla",
      version: GENERATED_CONFIG.legal.current.icla,
      textSha256: GENERATED_CONFIG.legal.editions.icla.find((e) => e.version === GENERATED_CONFIG.legal.current.icla)!.sha256,
    });
  });

  it("an explicit decline records past_contributions_included: false", async () => {
    const res = await app().request("/icla/sign", {
      method: "POST",
      headers: authed(),
      body: new URLSearchParams({ terms: "on", past_declined: "yes", csrf }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)["past_contributions_included"]).toBe(false);
  });
});

describe("my agreements view", () => {
  it("lists the signer's ICLA signatures and OCLA coverages with staleness flags", async () => {
    const res = await app().request("/agreements", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["bound"]).toMatchObject({ github_login: "tj-91" });
    const iclas = body["iclaSignatures"] as Array<{ current: boolean }>;
    const oclas = body["oclaCoverages"] as Array<{ org: string; current: boolean }>;
    expect(iclas).toHaveLength(1);
    expect(iclas[0]!.current).toBe(true); // fixture pins the current edition
    expect(oclas.map((o) => o.org)).toContain("mtg-ag");
    expect(oclas[0]!.current).toBe(true);
  });
});

describe("edition text serving", () => {
  it("serves the hash-verified text of a deployed edition", async () => {
    const v = GENERATED_CONFIG.legal.current.icla;
    const res = await app().request(`/agreements/text/icla/${v}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["sha256"]).toBe(GENERATED_CONFIG.legal.editions.icla.find((e) => e.version === v)!.sha256);
    expect(typeof body["text"]).toBe("string");
  });

  it("unknown versions and kinds 404; unauthenticated 401", async () => {
    const a = app();
    expect((await a.request("/agreements/text/icla/9.9", { headers: authed() })).status).toBe(404);
    expect((await a.request("/agreements/text/nope/1.0", { headers: authed() })).status).toBe(404);
    expect((await a.request("/agreements/text/icla/1.0")).status).toBe(401);
  });
});
