import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { signCompletionToken, readCompletionToken, isAgreeCommand } from "../src/portal/completion";
import { makeSessionCookie, SESSION_COOKIE } from "../src/portal/session";
import { makeFixture, makeKeyPem, WEBHOOK_SECRET, hmacHex, type Fixture } from "./helpers";

const ENV = (pem: string) => ({
  OIDC_CLIENT_SECRET: "op-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_ID: "1",
  APP_PRIVATE_KEY: pem,
  WEBHOOK_SECRET,
});

let pem: string;
let fx: Fixture;

const app = () => createApp(ENV(pem), { fetcher: fx.fetcher });

const commentPayload = (commenter: string, body: string, isPr = true) => ({
  action: "created",
  installation: { id: 42 },
  repository: { full_name: "rnpgp/rnp" },
  issue: { number: 1, user: { login: "pr-author" }, ...(isPr ? { pull_request: {} } : {}) },
  comment: { user: { login: commenter }, body },
});

async function deliverComment(payload: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(payload);
  const sig = await hmacHex(WEBHOOK_SECRET, raw);
  return app().request("/api/github/webhook", {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", "x-github-event": "issue_comment", "x-hub-signature-256": `sha256=${sig}` },
  });
}

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
});

describe("command parsing", () => {
  it("exact match, case-insensitive; near-misses rejected", () => {
    expect(isAgreeCommand("@ribose-cla agree")).toBe(true);
    expect(isAgreeCommand("  @Ribose-CLA AGREE \n")).toBe(true);
    expect(isAgreeCommand("@ribose-cla agreed")).toBe(false);
    expect(isAgreeCommand("I @ribose-cla agree with this")).toBe(false);
    expect(isAgreeCommand("")).toBe(false);
  });
});

describe("issue_comment: @ribose-cla agree", () => {
  it("a committer's command gets the signed completion link", async () => {
    const res = await deliverComment(commentPayload("stranger", "@ribose-cla agree"));
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["replied"]).toBe(true);

    const reply = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).at(-1);
    const text = (reply!.body as Record<string, unknown>)["body"] as string;
    expect(text).toContain("@stranger");
    expect(text).toContain("Individual CLA");
    const m = text.match(/t=([A-Za-z0-9_.-]+)/)!;
    const token = await readCompletionToken("op-secret", m![1], Date.now());
    expect(token).toMatchObject({ repo: "rnpgp/rnp", pr: 1, login: "stranger" });
  });

  it("an already-signed committer is told so (no completion link)", async () => {
    const res = await deliverComment(commentPayload("tj-91", "@ribose-cla agree"));
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["reason"]).toBe("already-signed");
    const reply = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).at(-1);
    expect(((reply!.body as Record<string, unknown>)["body"] as string)).toContain("already signed");
    expect(((reply!.body as Record<string, unknown>)["body"] as string)).not.toContain("/icla/complete");
  });

  it("non-committers are silently ignored", async () => {
    const res = await deliverComment(commentPayload("random-person", "@ribose-cla agree"));
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["replied"]).toBe(false);
    expect(fx.calls.some((c) => c.method === "POST" && c.url.endsWith("/comments"))).toBe(false);
  });

  it("bot comments and non-PR issues are ignored", async () => {
    expect(((await deliverComment(commentPayload("dependabot[bot]", "@ribose-cla agree"))).json() as Promise<Record<string, unknown>>)).resolves.toMatchObject({ ignored: expect.any(String) });
    expect(((await deliverComment(commentPayload("stranger", "@ribose-cla agree", false))).json() as Promise<Record<string, unknown>>)).resolves.toMatchObject({ ignored: expect.any(String) });
  });
});

describe("/icla/complete", () => {
  it("invalid tokens 400; matching session redirects to the ICLA form", async () => {
    const a = app();
    expect((await a.request("/icla/complete?t=bad.junk")).status).toBe(400);

    const session = await makeSessionCookie("op-secret", { sub: "s", login: "stranger", githubId: 5 }, Date.now());
    const token = await signCompletionToken("op-secret", { repo: "r", pr: 1, login: "stranger" }, Date.now());
    const res = await a.request(`/icla/complete?t=${token}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/icla");
  });

  it("without a session it starts the dual flow carrying next=/icla and the invited login", async () => {
    const token = await signCompletionToken("op-secret", { repo: "r", pr: 1, login: "stranger" }, Date.now());
    const res = await app().request(`/icla/complete?t=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    const flow = res.headers.getSetCookie().find((c) => c.startsWith("cla_flow="))!.split(";")[0]!.split("=").slice(1).join(".");
    const decoded = Buffer.from(flow.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    expect(decoded).toContain('"next":"/icla"');
    expect(decoded).toContain('"tlogin":"stranger"');
  });
});
