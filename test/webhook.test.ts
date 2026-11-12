import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { verifyWebhookSignature, parseEvent } from "../src/github/webhook";
import { conclusionFor, commentBody, COMMENT_MARKER, CHECK_NAME } from "../src/enforcement/checks";
import { fetchPrCommitters } from "../src/github/pulls";
import { makeFixture, pullRequestPayload, signedBody, makeKeyPem, hmacHex, WEBHOOK_SECRET, type Fixture } from "./helpers";
import { GithubApi, type GithubApiDeps } from "../src/github/api";
import type { PrVerdict } from "@riboseinc/cla-kernel";

// ---- signature verification: GitHub's documented test vector ----

describe("webhook signature", () => {
  it("matches GitHub's documented HMAC test vector", async () => {
    const digest = await hmacHex("It's a Secret to Everybody", "Hello, World!");
    expect(digest).toBe("757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
    expect(await verifyWebhookSignature("Hello, World!", `sha256=${digest}`, WEBHOOK_SECRET)).toBe(true);
  });

  it("rejects missing, malformed, and tampered signatures", async () => {
    const digest = await hmacHex(WEBHOOK_SECRET, "payload");
    expect(await verifyWebhookSignature("payload", undefined, WEBHOOK_SECRET)).toBe(false);
    expect(await verifyWebhookSignature("payload", "sha1=abc", WEBHOOK_SECRET)).toBe(false);
    expect(await verifyWebhookSignature("payload", `sha256=${"0".repeat(64)}`, WEBHOOK_SECRET)).toBe(false);
    expect(await verifyWebhookSignature("payload", `sha256=${digest}`, "wrong-secret")).toBe(false);
    expect(await verifyWebhookSignature("payload!", `sha256=${digest}`, WEBHOOK_SECRET)).toBe(false);
  });
});

describe("webhook route posture", () => {
  it("fail-closed: no secret configured -> the surface does not exist", async () => {
    const app = createApp({});
    const res = await app.request("/api/github/webhook", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("bad signature -> 401", async () => {
    const pem = await makeKeyPem();
    const app = createApp({ WEBHOOK_SECRET, GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem });
    const res = await app.request("/api/github/webhook", { method: "POST", body: "{}", headers: { "x-github-event": "pull_request" } });
    expect(res.status).toBe(401);
  });
});

// ---- verdict -> check-run mapping ----

describe("check-run mapping", () => {
  const v = (over: Partial<PrVerdict>): PrVerdict =>
    ({ verdict: "pass", committers: [], missing: [], mustSpecify: {}, ...over });

  it("pass -> success; missing -> failure; must-specify -> action_required", () => {
    expect(conclusionFor(v({}))).toBe("success");
    expect(conclusionFor(v({ verdict: "fail", missing: ["x"] }))).toBe("failure");
    expect(conclusionFor(v({ mustSpecify: { x: [] } }))).toBe("action_required");
  });

  it("failure wins over must-specify", () => {
    expect(conclusionFor(v({ verdict: "fail", missing: ["x"], mustSpecify: { y: [] } }))).toBe("failure");
  });
});

describe("comment body", () => {
  it("carries the marker, the verdict line, and the signing links", () => {
    const verdict: PrVerdict = {
      verdict: "fail",
      committers: [
        { login: "tj-91", status: "covered", path: "ocla", agreement: { kind: "ocla", version: "1.0", oclaId: "o", orgSlug: "mtg-ag" }, matchedBy: "login" },
        { login: "new-dev", status: "missing" },
      ],
      missing: ["new-dev"],
      mustSpecify: {},
    };
    const body = commentBody(verdict, "https://cla.example.org");
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain("merge blocked");
    expect(body).toContain("mtg-ag");
    expect(body).toContain("https://cla.example.org/icla");
    expect(body).toContain(CHECK_NAME);
  });
});

// ---- committer extraction ----

describe("pulls commits extraction", () => {
  it("excludes bots, dedupes logins, keeps emails for unlinked commits", async () => {
    const api = apiOver(async (url) => {
      if (url.pathname === "/repos/o/r/pulls/1/commits") {
        return Response.json(
          [
            { author: { login: "a", type: "User" }, commit: { author: { email: "a@x" } } },
            { author: { login: "a", type: "User" }, commit: { author: { email: "a@x" } } },
            { author: { login: "dep[bot]", type: "Bot" }, commit: { author: { email: "d@x" } } },
            { author: null, commit: { author: { email: "unlinked@x" } } },
          ],
          { status: 200 },
        );
      }
      throw new Error("unexpected " + url.pathname);
    });
    const { committers, truncated } = await fetchPrCommitters(api, 1, "o/r", 1);
    expect(truncated).toBe(false);
    expect(committers).toEqual([
      { login: "a", email: "a@x" },
      { login: null, email: "unlinked@x" },
    ]);
  });

  it("flags the 250-commit cap as truncated (honest, never a partial evaluation)", async () => {
    const api = apiOver(async (url) => {
      if (url.pathname === "/repos/o/r/pulls/1/commits") {
        return Response.json(Array.from({ length: 250 }, (_, i) => ({ author: { login: `u${i}`, type: "User" }, commit: { author: { email: `u${i}@x` } } })), { status: 200 });
      }
      throw new Error("unexpected");
    });
    const { truncated } = await fetchPrCommitters(api, 1, "o/r", 1);
    expect(truncated).toBe(true);
  });
});

// ---- the money leg: full route evaluation end-to-end ----

describe("POST /api/github/webhook: pull_request opened", () => {
  it("evaluates committers against the data repo and posts the failing check + comment", async () => {
    const pem = await makeKeyPem();
    const fx: Fixture = makeFixture();
    const app = createApp({ WEBHOOK_SECRET, GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem }, { fetcher: fx.fetcher });
    const { body, headers } = await signedBody(WEBHOOK_SECRET, pullRequestPayload());

    const res = await app.request("/api/github/webhook", { method: "POST", body, headers });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { outcome: string };
    expect(out.outcome).toContain("missing=1");

    const check = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"));
    expect(check).toBeDefined();
    expect(check!.body).toMatchObject({ name: CHECK_NAME, head_sha: "abc123", conclusion: "failure" });

    const comment = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments"));
    expect(comment).toBeDefined();
    expect((comment!.body as Record<string, unknown>)["body"]).toContain("@stranger");
    expect((comment!.body as Record<string, unknown>)["body"]).toContain("mtg-ag"); // tj-91's coverage source
  });

  it("updates the existing thread comment in place (no comment spam)", async () => {
    const pem = await makeKeyPem();
    const fx: Fixture = makeFixture();
    fx.routes.set("/repos/rnpgp/rnp/issues/1/comments", () =>
      Response.json([{ id: 99, body: `${COMMENT_MARKER}\nold content`, user: { login: "ribose-cla[bot]" } }], { status: 200 }),
    );
    const app = createApp({ WEBHOOK_SECRET, GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem }, { fetcher: fx.fetcher });
    const { body, headers } = await signedBody(WEBHOOK_SECRET, pullRequestPayload());
    await app.request("/api/github/webhook", { method: "POST", body, headers });

    expect(fx.calls.some((c) => c.method === "PATCH" && c.url.includes("/issues/comments/99"))).toBe(true);
    expect(fx.calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments"))).toBe(false);
  });

  it("data-store failure -> honest 503 (GitHub redelivers; never a fake pass)", async () => {
    const pem = await makeKeyPem();
    const fx: Fixture = makeFixture();
    fx.routes.set("/repos/example-org/cla-data/git/trees/HEAD", () => new Response("nope", { status: 500 }));
    const app = createApp({ WEBHOOK_SECRET, GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem }, { fetcher: fx.fetcher });
    const { body, headers } = await signedBody(WEBHOOK_SECRET, pullRequestPayload());
    const res = await app.request("/api/github/webhook", { method: "POST", body, headers });
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBeDefined();
    expect(fx.calls.some((c) => c.url.endsWith("/check-runs"))).toBe(false);
  });
});

describe("installation pre-registration", () => {
  it("posts a neutral check on the default branch HEAD", async () => {
    const pem = await makeKeyPem();
    const fx: Fixture = makeFixture();
    fx.routes.set("/repos/org/repo", () => Response.json({ default_branch: "main" }, { status: 200 }));
    fx.routes.set("/repos/org/repo/commits/main", () => Response.json({ sha: "def456" }, { status: 200 }));
    const app = createApp({ WEBHOOK_SECRET, GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem }, { fetcher: fx.fetcher });

    const payload = { action: "added", installation: { id: 42 }, repositories_added: [{ full_name: "org/repo" }] };
    const { body, headers } = await signedBody(WEBHOOK_SECRET, payload);
    const res = await app.request("/api/github/webhook", { method: "POST", body, headers: { ...headers, "x-github-event": "installation_repositories" } });

    expect(res.status).toBe(200);
    const check = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/org/repo/check-runs"));
    expect(check!.body).toMatchObject({ name: CHECK_NAME, conclusion: "neutral", head_sha: "def456" });
  });
});

// ---- helpers ----

function apiOver(fn: (url: URL, init?: RequestInit) => Promise<Response>): GithubApi {
  const deps: GithubApiDeps = {
    fetcher: async (url, init) => fn(new URL(url), init),
    now: () => 0,
    appId: "1",
    privateKeyPem: "placeholder",
    tokenCache: { get: () => "tok", put: () => {} },
    etagCache: { get: () => undefined, put: () => {} },
  };
  // bypass real JWT/token minting: the fixture token cache always hits
  return new GithubApi({ ...deps, privateKeyPem: "placeholder" } as GithubApiDeps);
}

describe("event parsing", () => {
  it("parses event + action and rejects broken payloads", () => {
    expect(parseEvent("pull_request", JSON.stringify({ action: "opened" }))?.action).toBe("opened");
    expect(parseEvent(undefined, "{}")).toBeUndefined();
    expect(parseEvent("pull_request", "not json")).toBeUndefined();
  });
});
