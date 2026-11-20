import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { drainSweepStep, enqueueSweepFor } from "../src/enforcement/sweep";
import { openPrsForLogin, upsertOpenPr, removeOpenPr } from "../src/store/db";
import { makeFixture, makeKeyPem, WEBHOOK_SECRET, signedBody, pullRequestPayload, type Fixture } from "./helpers";

/**
 * The open-PR index (rnpgp/rnp#2587): the sweep reads a login's open
 * pull requests from the D1 index that the pull_request webhooks
 * populate, instead of enumerating every installation and repository
 * per login (the estate walk measured hours to reach a signed PR).
 */

const memoryD1 = () => {
  const queue = new Map<string, { login: string; queued_at: string; attempts: number; cursor: string | null }>();
  const prs = new Map<string, { repo: string; pr: number; login: string; installation_id: number; head_sha: string | null; updated_at: string }>();
  return {
    queue,
    prs,
    prepare(sql: string) {
      return {
        bind: (...v: unknown[]) => ({
          run: async () => {
            if (sql.startsWith("INSERT INTO sweep_queue")) queue.set(v[0] as string, { login: v[0] as string, queued_at: v[1] as string, attempts: 0, cursor: null });
            if (sql.startsWith("UPDATE sweep_queue")) {
              const r = queue.get(v[2] as string);
              if (r) {
                r.attempts = v[0] as number;
                r.cursor = v[1] as string | null;
              }
            }
            if (sql.startsWith("DELETE FROM sweep_queue")) queue.delete(v[0] as string);
            if (sql.startsWith("INSERT INTO open_prs")) prs.set(`${v[0]}#${v[1]}`, { repo: v[0] as string, pr: v[1] as number, login: v[2] as string, installation_id: v[3] as number, head_sha: (v[4] as string | null) ?? null, updated_at: v[5] as string });
            if (sql.startsWith("DELETE FROM open_prs")) prs.delete(`${v[0]}#${v[1]}`);
          },
          all: async () => {
            if (sql.startsWith("SELECT repo, pr, login")) {
              const login = v[0] as string;
              const matches = [...prs.values()].filter((r) => r.login === login).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
              return { results: matches.map((r) => ({ repo: r.repo, pr: r.pr, installation_id: r.installation_id, head_sha: r.head_sha })) };
            }
            return { results: [] };
          },
          first: async <T>() => {
            const oldest = [...queue.values()].sort((a, b) => a.queued_at.localeCompare(b.queued_at))[0];
            return (oldest ? { login: oldest.login, attempts: oldest.attempts, cursor: oldest.cursor } : null) as T | null;
          },
        }),
      };
    },
  };
};

let pem: string;
let fx: Fixture;
const envOf = (db: unknown) => ({ GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem, WEBHOOK_SECRET, OIDC_CLIENT_SECRET: "op-secret", DB: db as never });

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
});

describe("the open-PR index (rnpgp/rnp#2587)", () => {
  it("a pull_request opened event indexes the PR for the sweep", async () => {
    const db = memoryD1();
    const payload = pullRequestPayload({
      action: "opened",
      pull_request: { head: { sha: "abc123" }, user: { login: "computerquip-work", type: "User" } },
    });
    const { body, headers } = await signedBody(WEBHOOK_SECRET, payload);
    await createApp(envOf(db) as never, { fetcher: fx.fetcher }).request("/api/github/webhook", { method: "POST", body, headers });
    const rows = await openPrsForLogin(db as never, "computerquip-work");
    expect(rows).toEqual([{ repo: "rnpgp/rnp", pr: 1, login: "computerquip-work", installationId: 42, headSha: "abc123" }]);
  });

  it("a pull_request closed event removes the indexed PR", async () => {
    const db = memoryD1();
    await upsertOpenPr(db as never, { repo: "rnpgp/rnp", pr: 1, login: "computerquip-work", installationId: 42, headSha: "abc123" });
    const payload = pullRequestPayload({ action: "closed" });
    const { body, headers } = await signedBody(WEBHOOK_SECRET, payload);
    await createApp(envOf(db) as never, { fetcher: fx.fetcher }).request("/api/github/webhook", { method: "POST", body, headers });
    expect(await openPrsForLogin(db as never, "computerquip-work")).toEqual([]);
  });

  it("the sweep evaluates indexed PRs directly — no estate walk", async () => {
    const db = memoryD1();
    await upsertOpenPr(db as never, { repo: "rnpgp/rnp", pr: 1, login: "contributor-a", installationId: 42, headSha: "abc123" });
    await enqueueSweepFor(envOf(db) as never, ["contributor-a"]);
    const out = (await drainSweepStep(envOf(db), fx.fetcher)) as { drained?: string; evaluated?: string[] };
    expect(out.drained).toBe("contributor-a");
    expect(out.evaluated?.some((e) => e.startsWith("rnpgp/rnp#1"))).toBe(true);
    // the fast path never enumerated installations for a walk
    expect(fx.calls.filter((c) => c.url.includes("/app/installations")).length).toBe(0);
    expect(db.queue.size).toBe(0);
  });

  it("the walk fallback feeds the index as it discovers legacy PRs", async () => {
    const db = memoryD1();
    fx.routes.set("/app/installations", () => Response.json({ installations: [{ id: 42, account: { login: "rnpgp" } }] }, { status: 200 }));
    fx.routes.set("/installation/repositories", () => Response.json({ repositories: [{ full_name: "rnpgp/rnp" }] }, { status: 200 }));
    fx.routes.set("/repos/rnpgp/rnp/pulls", () => Response.json([{ number: 1, user: { login: "contributor-a" } }], { status: 200 }));
    await enqueueSweepFor(envOf(db) as never, ["contributor-a"]);
    await drainSweepStep(envOf(db), fx.fetcher);
    const rows = await openPrsForLogin(db as never, "contributor-a");
    expect(rows).toEqual([{ repo: "rnpgp/rnp", pr: 1, login: "contributor-a", installationId: 42, headSha: null }]);
    // a second sweep of the same login takes the fast path only
    const callsBefore = fx.calls.length;
    await enqueueSweepFor(envOf(db) as never, ["contributor-a"]);
    await drainSweepStep(envOf(db), fx.fetcher);
    expect(fx.calls.filter((c) => c.url.includes("/app/installations")).slice(callsBefore).length).toBe(0);
  });
});
