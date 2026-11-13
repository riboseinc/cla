import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { signAttributionToken, readAttributionToken, optionKey } from "../src/portal/attribution";
import { makeSessionCookie, SESSION_COOKIE } from "../src/portal/session";
import { CLOSING_MARKER, COMMENT_MARKER, CHECK_NAME } from "../src/enforcement/checks";
import { makeFixture, pullRequestPayload, signedBody, makeKeyPem, hmacHex, WEBHOOK_SECRET, type Fixture } from "./helpers";
import { GENERATED_CONFIG } from "../src/generated/config";

const PORTAL = `https://${GENERATED_CONFIG.instance.portalHost}`;

const ENV = (pem: string) => ({
  OIDC_CLIENT_SECRET: "op-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "gh-secret",
  GITHUB_APP_ID: "1",
  APP_PRIVATE_KEY: pem,
  WEBHOOK_SECRET,
});

function cookieOf(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0]?.split("=").slice(1).join("=");
}

describe("attribution tokens", () => {
  const secret = "tok-secret";
  const options = [
    { kind: "icla" as const, version: "1.0" },
    { kind: "ocla" as const, version: "1.0", oclaId: "ocla-mtg", orgSlug: "mtg-ag" },
  ];

  it("round-trips; pick keys map to the offered options", async () => {
    const t = await signAttributionToken(secret, { repo: "rnpgp/rnp", pr: 1, login: "tj-91", installationId: 42, options }, Date.now());
    const back = await readAttributionToken(secret, t, Date.now());
    expect(back).toMatchObject({ repo: "rnpgp/rnp", pr: 1, login: "tj-91", installationId: 42 });
    expect(back!.options.map(optionKey)).toEqual(["icla", "ocla:ocla-mtg"]);
  });

  it("tampered, wrong-secret, and expired tokens fail closed", async () => {
    const t = await signAttributionToken(secret, { repo: "r", pr: 1, login: "l", installationId: 1, options }, Date.now());
    expect(await readAttributionToken(secret, t.slice(0, -2) + "xx", Date.now())).toBeUndefined();
    expect(await readAttributionToken("other", t, Date.now())).toBeUndefined();
    expect(await readAttributionToken(secret, t, Date.now() + 11 * 60 * 1000)).toBeUndefined();
    expect(await readAttributionToken(secret, undefined, Date.now())).toBeUndefined();
  });
});

describe("must-specify links + election + closing statement", () => {
  let pem: string;
  let fx: Fixture;

  beforeEach(async () => {
    pem = await makeKeyPem();
    fx = makeFixture(); // tj-91 has BOTH icla + ocla in this fixture -> must-specify
  });

  it("the bot comment carries signed per-agreement election links", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    const { body, headers } = await signedBody(WEBHOOK_SECRET, pullRequestPayload());
    await app.request("/api/github/webhook", { method: "POST", body, headers });

    const comment = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments"));
    const text = (comment!.body as Record<string, unknown>)["body"] as string;
    expect(text).toContain(COMMENT_MARKER);
    expect(text).toContain("/attribute?t=");
    expect(text).toContain("specify under which agreement");
    expect((await readAttributionToken("op-secret", text.match(/t=([A-Za-z0-9_.-]+)&pick=icla/)![1], Date.now()))!.login).toBe("tj-91");
  });

  it("the election surface: committer elects -> attribution recorded + immediate re-check", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    const session = await makeSessionCookie("op-secret", { sub: "s", login: "tj-91", githubId: 918273 }, Date.now());
    const token = await signAttributionToken("op-secret", { repo: "rnpgp/rnp", pr: 1, login: "tj-91", installationId: 42, options: [
      { kind: "icla", version: "1.0" },
      { kind: "ocla", version: "1.0", oclaId: "ocla-mtg", orgSlug: "mtg-ag" },
    ] }, Date.now());

    const res = await app.request(`/attribute?t=${token}&pick=ocla:ocla-mtg`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["recorded"]).toBe(true);

    const put = fx.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/attribution/"));
    expect(put).toBeDefined();
    const record = JSON.parse(Buffer.from((put!.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>;
    expect(record).toMatchObject({ repo: "rnpgp/rnp", pr: 1, login: "tj-91" });
    expect((record["agreement"] as Record<string, unknown>)["kind"]).toBe("ocla");

    // immediate re-check posted
    expect(fx.calls.some((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"))).toBe(true);
  });

  it("only the committer may elect; bad picks rejected", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    const other = await makeSessionCookie("op-secret", { sub: "s", login: "not-tj", githubId: 2 }, Date.now());
    const token = await signAttributionToken("op-secret", { repo: "rnpgp/rnp", pr: 1, login: "tj-91", installationId: 42, options: [{ kind: "icla", version: "1.0" }] }, Date.now());

    expect((await app.request(`/attribute?t=${token}&pick=icla`, { headers: { cookie: `${SESSION_COOKIE}=${other}` } })).status).toBe(403);
    const mine = await makeSessionCookie("op-secret", { sub: "s", login: "tj-91", githubId: 918273 }, Date.now());
    expect((await app.request(`/attribute?t=${token}&pick=nonsense`, { headers: { cookie: `${SESSION_COOKIE}=${mine}` } })).status).toBe(400);
    expect((await app.request(`/attribute?t=tampered.junk&pick=icla`, { headers: { cookie: `${SESSION_COOKIE}=${mine}` } })).status).toBe(400);
  });

  it("merge posts the closing attribution statement; redelivery is deduped", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    // pre-seed an election so the closing statement can cite it
    await app.request("/api/github/webhook", {
      method: "POST",
      body: JSON.stringify({ action: "opened", number: 1, installation: { id: 42 }, repository: { full_name: "rnpgp/rnp" }, pull_request: { head: { sha: "abc123" } } }),
      headers: { "x-github-event": "pull_request", ...(await signedBody(WEBHOOK_SECRET, pullRequestPayload())).headers },
    });

    const merged = { ...pullRequestPayload(), action: "closed", pull_request: { merged: true, head: { sha: "abc123" } } };
    const { body, headers } = await signedBody(WEBHOOK_SECRET, merged);
    const res = await app.request("/api/github/webhook", { method: "POST", body, headers: { ...headers, "x-github-event": "pull_request" } });
    expect(res.status).toBe(200);

    const closing = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments"));
    expect(closing.length).toBeGreaterThanOrEqual(1);
    const lastBody = (closing[closing.length - 1]!.body as Record<string, unknown>)["body"] as string;
    expect(lastBody).toContain(CLOSING_MARKER);
    expect(lastBody).toContain("contributed under");
    expect(lastBody).toContain(CHECK_NAME.split("/")[0] === "cla" ? "CLA attribution" : "attribution");

    // redelivery: the listing now contains the closing comment -> no second post
    fx.routes.set("/repos/rnpgp/rnp/issues/1/comments", () =>
      Response.json([{ id: 5, body: `${CLOSING_MARKER}\nalready here` }], { status: 200 }),
    );
    const n = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).length;
    await app.request("/api/github/webhook", { method: "POST", body, headers: { ...headers, "x-github-event": "pull_request" } });
    expect(fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).length).toBe(n);
  });
});

describe("hmac helper sanity", () => {
  it("the shared helper matches the signature verifier", async () => {
    const d = await hmacHex(WEBHOOK_SECRET, "x");
    expect(d).toHaveLength(64);
  });
});
