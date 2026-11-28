import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { evaluateDefaultBranchPush } from "../src/enforcement/handler";
import { GithubApi } from "../src/github/api";
import { GENERATED_CONFIG } from "../src/generated/config";
import { makeFixture, checkSuitePayload, signedBody, makeKeyPem, WEBHOOK_SECRET, type Fixture } from "./helpers";
import { CHECK_NAME } from "../src/enforcement/checks";

// check_suite.requested on the DEFAULT branch: commits that landed
// outside any PR this App evaluated — advisory merges, VCS-bridge
// pushes. The verdict lands only as a check run (no PR thread).

describe("check_suite.requested on the default branch", () => {
  async function post(fx: Fixture, pem: string, payload: Record<string, unknown>) {
    const app = createApp({ WEBHOOK_SECRET, GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem }, { fetcher: fx.fetcher });
    const { body, headers } = await signedBody(WEBHOOK_SECRET, payload, "check_suite");
    return app.request("/api/github/webhook", { method: "POST", body, headers });
  }

  const postedCheck = (fx: Fixture) => fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"));

  it("evaluates landed committers: covered + missing -> failing check on the merge SHA", async () => {
    const pem = await makeKeyPem();
    const fx = makeFixture();
    const res = await post(fx, pem, checkSuitePayload());
    expect(res.status).toBe(200);
    const out = (await res.json()) as { outcome: string };
    expect(out.outcome).toContain("missing=1");

    const check = postedCheck(fx);
    expect(check).toBeDefined();
    expect(check!.body).toMatchObject({ name: CHECK_NAME, head_sha: "merge123", conclusion: "failure" });
    // No PR thread exists: nothing may comment.
    expect(fx.calls.some((c) => /\/issues\/\d+\/comments$/.test(c.url) && c.method === "POST")).toBe(false);
  });

  it("covered-only push -> success", async () => {
    const pem = await makeKeyPem();
    const fx = makeFixture();
    fx.routes.set("/repos/rnpgp/rnp/compare/oldsha...merge123", () =>
      new Response(JSON.stringify({
        total_commits: 1,
        commits: [{ sha: "m1", author: { login: "tj-91", type: "User" }, commit: { author: { email: "johannes@mtg.example" } } }],
        files: [{ additions: 5, deletions: 1 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await post(fx, pem, checkSuitePayload());
    expect(res.status).toBe(200);
    const check = postedCheck(fx);
    expect(check!.body).toMatchObject({ conclusion: "success" });
  });

  it("bot-only push -> success (bots are skipped)", async () => {
    const pem = await makeKeyPem();
    const fx = makeFixture();
    fx.routes.set("/repos/rnpgp/rnp/compare/oldsha...merge123", () =>
      new Response(JSON.stringify({
        total_commits: 1,
        commits: [{ sha: "m1", author: { login: "dependabot[bot]", type: "Bot" }, commit: { author: { email: "bot@x.example" } } }],
        files: [{ additions: 5, deletions: 1 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await post(fx, pem, checkSuitePayload());
    expect(res.status).toBe(200);
    const check = postedCheck(fx);
    expect(check!.body).toMatchObject({ conclusion: "success" });
  });

  it("non-default branch -> ignored without any evaluation", async () => {
    const pem = await makeKeyPem();
    const fx = makeFixture();
    const payload = checkSuitePayload({ check_suite: { head_branch: "feature", head_sha: "f1", before: "oldsha", pull_requests: [{ number: 9 }] } });
    const res = await post(fx, pem, payload);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ignored: string };
    expect(out.ignored).toContain("non-default");
    expect(postedCheck(fx)).toBeUndefined();
    expect(fx.calls.some((c) => c.url.includes("/compare/"))).toBe(false);
  });

  it("repos_without_cla repo -> out of scope by config", async () => {
    const pem = await makeKeyPem();
    const fx = makeFixture();
    const noopCache = { get: () => undefined, put: () => {} };
    const api = new GithubApi({ appId: "1", privateKeyPem: pem, fetcher: fx.fetcher, now: () => Date.now(), tokenCache: noopCache, etagCache: noopCache });
    const deps = { api, config: { ...GENERATED_CONFIG, coverage: { ...GENERATED_CONFIG.coverage, reposWithoutCla: ["rnpgp/rnp"] } } };
    const r = await evaluateDefaultBranchPush(deps, { installationId: 42, repoFullName: "rnpgp/rnp", headSha: "merge123", before: "oldsha" });
    expect(r.handled).toBe(false);
    expect(r.outcome).toContain("repos_without_cla");
    expect(fx.calls.some((c) => c.url.includes("/compare/"))).toBe(false);
  });

  it("branch-creation push (zero before) -> nothing to evaluate", async () => {
    const pem = await makeKeyPem();
    const fx = makeFixture();
    const payload = checkSuitePayload({ check_suite: { head_branch: "main", head_sha: "first", before: "0000000000000000000000000000000000000000", pull_requests: [] } });
    const res = await post(fx, pem, payload);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { outcome: string };
    expect(out.outcome).toContain("nothing to evaluate");
    expect(postedCheck(fx)).toBeUndefined();
  });

  it("truncated compare -> honest failing check", async () => {
    const pem = await makeKeyPem();
    const fx = makeFixture();
    fx.routes.set("/repos/rnpgp/rnp/compare/oldsha...merge123", () =>
      new Response(JSON.stringify({
        total_commits: 300,
        commits: [{ sha: "m1", author: { login: "tj-91", type: "User" }, commit: { author: { email: "johannes@mtg.example" } } }],
        files: [],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await post(fx, pem, checkSuitePayload());
    expect(res.status).toBe(200);
    const check = postedCheck(fx);
    expect(check!.body).toMatchObject({ conclusion: "failure" });
    expect((check!.body as Record<string, unknown>)["output"]).toMatchObject({ summary: expect.stringContaining("commit cap") });
  });

  it("compare failure -> honest 503 (fail-closed; GitHub redelivers)", async () => {
    const pem = await makeKeyPem();
    const fx = makeFixture();
    fx.routes.set("/repos/rnpgp/rnp/compare/oldsha...merge123", () => new Response("boom", { status: 500 }));
    const res = await post(fx, pem, checkSuitePayload());
    expect(res.status).toBe(503);
  });
});
