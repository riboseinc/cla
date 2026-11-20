import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { makeFixture, makeKeyPem, WEBHOOK_SECRET, CURRENT_EDITIONS, pullRequestPayload, signedBody, type Fixture } from "./helpers";

let pem: string;
let fx: Fixture;

const app = () => createApp({ WEBHOOK_SECRET, GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem }, { fetcher: fx.fetcher });

const commentPayload = (commenter: string, body: string, isPr = true) => ({
  action: "created",
  installation: { id: 42 },
  repository: { full_name: "rnpgp/rnp" },
  issue: { number: 1, user: { login: "pr-author" }, ...(isPr ? { pull_request: {} } : {}) },
  comment: { user: { login: commenter, id: 4242 }, body },
});

async function deliverComment(payload: Record<string, unknown>): Promise<Response> {
  const { body, headers } = await signedBody(WEBHOOK_SECRET, payload);
  return app().request("/api/github/webhook", {
    method: "POST",
    body,
    headers: { ...headers, "x-github-event": "issue_comment" },
  });
}

const lastReply = (): string => {
  const reply = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).at(-1);
  return (reply!.body as Record<string, unknown>)["body"] as string;
};

const legalWrites = () => fx.calls.filter((c) => c.method === "PUT" && c.url.includes("/contents/"));

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
});

describe("issue_comment: @ribose-cla help", () => {
  it("replies to a committer's help command with the available commands", async () => {
    const res = await deliverComment(commentPayload("stranger", "  @RIBOSE-CLA HELP\n"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replied: true, reason: "help posted" });
    expect(lastReply()).toContain("@ribose-cla status");
    expect(lastReply()).toContain("@ribose-cla recheck");
    expect(legalWrites()).toEqual([]);
  });
});

describe("issue_comment: @ribose-cla status", () => {
  it("reports a committer's recorded Individual CLA", async () => {
    const res = await deliverComment(commentPayload("tj-91", "@ribose-cla status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replied: true, reason: "status: icla" });
    expect(lastReply()).toContain("@tj-91");
    expect(lastReply()).toContain("Individual CLA");
    expect(legalWrites()).toEqual([]);
  });

  it("answers a PR author's status command without granting coverage", async () => {
    const res = await deliverComment(commentPayload("pr-author", "@ribose-cla status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replied: true, reason: "status: none" });
    expect(lastReply()).toContain("no live agreement is on record");
    expect(legalWrites()).toEqual([]);
    expect(fx.calls.some((c) => c.method === "POST" && c.url.endsWith("/check-runs"))).toBe(false);
  });
});

describe("issue_comment: @ribose-cla recheck", () => {
  it("refreshes a failing check after a signature appears in the data repo", async () => {
    fx.routes.set("/repos/rnpgp/rnp/pulls/1/commits", () =>
      Response.json([{ author: { login: "stranger", type: "User" }, commit: { author: { email: "s@x.example" } } }]),
    );
    const { body, headers } = await signedBody(WEBHOOK_SECRET, pullRequestPayload());
    const opened = await app().request("/api/github/webhook", { method: "POST", body, headers });
    expect(opened.status).toBe(200);
    const checks = () => fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
    expect(checks()).toHaveLength(1);
    expect(checks()[0]!.body).toMatchObject({ head_sha: "abc123", conclusion: "failure" });

    fx.routes.set("/repos/example-org/cla-data/git/trees/HEAD", () =>
      Response.json({ tree: [{ path: "icla/2026/11/stranger.json", type: "blob" }] }),
    );
    fx.routes.set("/repos/example-org/cla-data/contents/icla/2026/11/stranger.json", () =>
      Response.json({
        content: Buffer.from(JSON.stringify({
          id: "icla-stranger",
          githubLogin: "stranger",
          email: "s@x.example",
          claEdition: { kind: "icla", version: CURRENT_EDITIONS.icla.version, textSha256: CURRENT_EDITIONS.icla.sha256 },
          pastContributionsIncluded: true,
          source: "portal",
        })).toString("base64"),
        encoding: "base64",
      }),
    );

    const res = await deliverComment(commentPayload("stranger", "@ribose-cla recheck"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replied: true, reason: "recheck run" });
    expect(checks()).toHaveLength(2);
    expect(checks()[1]!.body).toMatchObject({ head_sha: "abc123", conclusion: "success" });
    expect(lastReply()).toContain("re-ran the check on the current head");
    expect(legalWrites()).toEqual([]);
  });

  it("keeps the check failing when a recheck finds no signature", async () => {
    const res = await deliverComment(commentPayload("stranger", "@ribose-cla recheck"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replied: true, reason: "recheck run" });
    const check = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
    expect(check!.body).toMatchObject({ head_sha: "abc123", conclusion: "failure" });
    expect(legalWrites()).toEqual([]);
  });
});

describe("issue_comment: ignored meta commands", () => {
  it.each(["help", "status", "recheck"])("ignores %s from a non-participant", async (command) => {
    const res = await deliverComment(commentPayload("random-person", `@ribose-cla ${command}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replied: false, reason: "not a committer (ignored)" });
    expect(fx.calls.some((c) => c.method !== "GET" && !c.url.includes("/access_tokens"))).toBe(false);
  });

  it.each(["help", "status", "recheck"])("ignores %s on ordinary issues", async (command) => {
    const res = await deliverComment(commentPayload("stranger", `@ribose-cla ${command}`, false));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "not a command on a PR" });
    expect(fx.calls).toEqual([]);
  });

  it.each(["help", "status", "recheck"])("ignores %s from bots", async (command) => {
    const res = await deliverComment(commentPayload("dependabot[bot]", `@ribose-cla ${command}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "not a command on a PR" });
    expect(fx.calls).toEqual([]);
  });

  it("ignores a near-miss command", async () => {
    const res = await deliverComment(commentPayload("stranger", "@ribose-cla recheck please"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "not a command on a PR" });
    expect(fx.calls).toEqual([]);
  });
});
