import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { signCompletionToken, readCompletionToken, isAgreeCommand } from "../src/portal/completion";
import { makeSessionCookie, SESSION_COOKIE } from "../src/portal/session";
import { makeFixture, makeKeyPem, WEBHOOK_SECRET, hmacHex, type Fixture } from "./helpers";

const ENV = (pem: string) => ({
  OIDC_CLIENT_SECRET: "op-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "gh-secret",
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

  it("without a session it lands on the PAPER first (the agreement renders pre-sign-in), carrying next=/icla and the invited login", async () => {
    const token = await signCompletionToken("op-secret", { repo: "r", pr: 1, login: "stranger" }, Date.now());
    const res = await app().request(`/icla/complete?t=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/icla");
    expect(res.headers.get("location")).not.toContain("github.com");
    const flow = res.headers.getSetCookie().find((c) => c.startsWith("cla_flow="))!.split(";")[0]!.split("=").slice(1).join(".");
    const decoded = Buffer.from(flow.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    expect(decoded).toContain('"next":"/icla"');
    expect(decoded).toContain('"tlogin":"stranger"');
  });
});

// ---- issue #57: `agree icla` / `agree company="..."` ----

describe("issue_comment: @ribose-cla agree grammar (issue #57)", () => {
  it("the parser recognizes the whole grammar, nothing else", () => {
    expect(isAgreeCommand("@ribose-cla agree icla")).toBe(true);
    expect(isAgreeCommand("@Ribose-CLA AGREE ICLA")).toBe(true);
    expect(isAgreeCommand('@ribose-cla agree company="mtg-ag"')).toBe(true);
    expect(isAgreeCommand("@ribose-cla agree company=mtg-ag")).toBe(true);
    expect(isAgreeCommand("@ribose-cla agree company=")).toBe(false);
    expect(isAgreeCommand("@ribose-cla agree icla extra")).toBe(false);
  });

  it("agree icla on a must-specify PR elects the ICLA, records, and re-checks", async () => {
    // tj-91 is covered by BOTH the mtg-ag OCLA row and their own ICLA —
    // the kernel reports must-specify; the comment elects the ICLA.
    const res = await deliverComment(commentPayload("tj-91", "@RIBOSE-CLA AGREE ICLA"));
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["replied"]).toBe(true);
    expect(out["reason"]).toBe("election recorded");

    const put = fx.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/attribution/"));
    expect(put).toBeDefined();
    const record = JSON.parse(Buffer.from((put!.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>;
    expect(record).toMatchObject({ repo: "rnpgp/rnp", pr: 1, login: "tj-91", agreement: { kind: "icla" } });

    const reply = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).at(-1);
    expect(((reply!.body as Record<string, unknown>)["body"] as string)).toContain("contributed under **the Individual CLA v");
    // the immediate re-check: a fresh check run posted on the head sha
    expect(fx.calls.some((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"))).toBe(true);
  });

  it("agree icla when already covered answers, records nothing", async () => {
    // falko-strenzke is covered via exactly one agreement (the mtg-ag OCLA)
    fx.routes.set("/repos/rnpgp/rnp/pulls/1/commits", () =>
      Response.json([{ author: { login: "falko-strenzke", type: "User" }, commit: { author: { email: "falko@mtg.example" } } }], { status: 200 }),
    );
    const res = await deliverComment(commentPayload("falko-strenzke", "@ribose-cla agree icla"));
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["reason"]).toBe("already covered");
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/attribution/"))).toBe(false);
  });

  it('agree company="mtg-ag" elects the org OCLA for a must-specify roster member', async () => {
    const res = await deliverComment(commentPayload("tj-91", '@ribose-cla agree company="mtg-ag"'));
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["reason"]).toBe("election recorded");
    const put = fx.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/attribution/"));
    const record = JSON.parse(Buffer.from((put!.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>;
    expect(record["agreement"]).toMatchObject({ kind: "ocla", orgSlug: "mtg-ag" });
  });

  it('agree company="..." from a non-roster committer files a join request (never self-coverage)', async () => {
    const memoryD1 = () => {
      const rows: Array<Record<string, unknown>> = [];
      return {
        prepare(sql: string) {
          return {
            bind: (...v: unknown[]) => ({
              run: async () => {
                rows.push({ ocla_id: v[1], login: v[2], status: "pending" });
              },
              all: async () => ({ results: [] }),
              first: async () => (rows.find((r) => r["ocla_id"] === v[0] && r["login"] === v[1] && r["status"] === "pending") ?? null),
            }),
          };
        },
        rows,
      };
    };
    const a = createApp({ ...ENV(pem), DB: memoryD1() as unknown as D1Database }, { fetcher: fx.fetcher });
    const raw = JSON.stringify(commentPayload("stranger", "@ribose-cla agree company=mtg-ag"));
    const sig = await hmacHex(WEBHOOK_SECRET, raw);
    const res = await a.request("/api/github/webhook", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "x-github-event": "issue_comment", "x-hub-signature-256": `sha256=${sig}` },
    });
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["reason"]).toBe("join request sent");
    const reply = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).at(-1);
    const text = (reply!.body as Record<string, unknown>)["body"] as string;
    expect(text).toContain("join request was sent");
    expect(text).toContain("never grants coverage by itself");
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/attribution/"))).toBe(false);
  });

  it('agree company="nope" with no such organization answers honestly', async () => {
    const res = await deliverComment(commentPayload("stranger", '@ribose-cla agree company="nope"'));
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["reason"]).toBe("no such organization");
  });
});
