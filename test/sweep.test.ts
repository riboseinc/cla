import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { drainSweepStep, enqueueSweepFor } from "../src/enforcement/sweep";
import { makeFixture, makeKeyPem, WEBHOOK_SECRET, hmacHex, signedBody, pullRequestPayload, type Fixture } from "./helpers";

/**
 * The write-back sweep (issue #59): a record append queues the login;
 * a bounded drain step re-evaluates the login's open PRs across
 * installations, persists a cursor when the budget runs out, and
 * completes the queue entry when done. Idempotent; safe to retry.
 */

const memoryD1 = () => {
  const rows = new Map<string, { login: string; queued_at: string; attempts: number; cursor: string | null }>();
  return {
    rows,
    prepare(sql: string) {
      return {
        bind: (...v: unknown[]) => ({
          run: async () => {
            if (sql.startsWith("INSERT INTO sweep_queue")) rows.set(v[0] as string, { login: v[0] as string, queued_at: v[1] as string, attempts: 0, cursor: null });
            if (sql.startsWith("UPDATE sweep_queue")) {
              const r = rows.get(v[2] as string);
              if (r) {
                r.attempts = v[0] as number;
                r.cursor = v[1] as string | null;
              }
            }
            if (sql.startsWith("DELETE FROM sweep_queue")) rows.delete(v[0] as string);
          },
          all: async () => ({ results: [] }),
          first: async <T>() => {
            const oldest = [...rows.values()].sort((a, b) => a.queued_at.localeCompare(b.queued_at))[0];
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

const deliverWebhook = async (payload: Record<string, unknown>) => {
  const { body, headers } = await signedBody(WEBHOOK_SECRET, payload);
  return createApp(envOf(null)).request("/api/github/webhook", { method: "POST", body, headers });
};

describe("the sweep queue (issue #59)", () => {
  it("a signing enqueues the signer; the drain re-evaluates that login's open PRs and completes the entry", async () => {
    const db = memoryD1();
    // the portal sign (a real app with the DB)
    const app = createApp({ ...envOf(db), OIDC_CLIENT_SECRET: "op-secret", GITHUB_APP_CLIENT_ID: "Iv1.client", GITHUB_APP_CLIENT_SECRET: "gh-secret" } as never, { fetcher: fx.fetcher });
    const { makeSessionCookie, SESSION_COOKIE, newCsrfToken, CSRF_COOKIE } = await import("../src/portal/session");
    const session = await makeSessionCookie("op-secret", { sub: "sub-1", login: "stranger", githubId: 5, email: "s@x.example", emailVerified: true }, Date.now());
    const csrf = newCsrfToken();
    await app.request("/icla/sign", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}` },
      body: new URLSearchParams({ terms: "on", past: "yes", csrf, name: "Stranger Person", email: "s@x.example" }),
    });
    expect(db.rows.has("stranger")).toBe(true);

    // two open PRs for the login, across TWO installations
    fx.routes.set("/app/installations", () => Response.json({ installations: [{ id: 42, account: { login: "rnpgp" } }, { id: 7, account: { login: "metanorma" } }] }, { status: 200 }));
    fx.routes.set("/app/installations/42/access_tokens", () => Response.json({ token: "ghs_42" }, { status: 201 }));
    fx.routes.set("/app/installations/7/access_tokens", () => Response.json({ token: "ghs_7" }, { status: 201 }));
    fx.routes.set("/search/issues", () => Response.json({ items: [] }, { status: 200 }));
    fx.routes.set("/search/issues?per_page=50", () => Response.json({ items: [] }, { status: 200 }));
    const searchRoute = (q: string, items: Array<{ number: number; repository_url: string }>) =>
      fx.routes.set(`/search/issues`, (_url) => {
        // the fixture fetcher keys routes by pathname only; dispatch on the
        // captured init? we encode the org in the path — use two path forms:
        return Response.json({ items }, { status: 200 });
      });
    // rnpgp's search: the fixture's route map is pathname-keyed, so the
    // two orgs need distinguishable paths — encode via the q param by
    // using per-installation route overrides is impossible; instead both
    // searches return their own PR via a closure that counts calls.
    let call = 0;
    fx.routes.set("/search/issues", () => {
      call++;
      return Response.json(
        {
          items:
            call === 1
              ? [{ number: 1, repository_url: "https://api.github.com/repos/rnpgp/rnp" }]
              : [{ number: 9, repository_url: "https://api.github.com/repos/metanorma/isodoc" }],
        },
        { status: 200 },
      );
    });
    fx.routes.set("/repos/metanorma/isodoc/pulls/9", () => Response.json({ head: { sha: "sha-9" }, changed_files: 5, additions: 40, deletions: 10 }, { status: 200 }));
    fx.routes.set("/repos/metanorma/isodoc/pulls/9/commits", () =>
      Response.json([{ author: { login: "stranger", type: "User" }, commit: { author: { email: "s@x.example" } } }], { status: 200 }),
    );

    const out = (await drainSweepStep(envOf(db), fx.fetcher)) as { drained?: string; evaluated?: string[]; done?: boolean };
    expect(out.drained).toBe("stranger");
    expect(out.done).toBe(true);
    expect(out.evaluated?.some((e) => e.startsWith("rnpgp/rnp#1"))).toBe(true);
    expect(out.evaluated?.some((e) => e.startsWith("metanorma/isodoc#9"))).toBe(true);
    expect(db.rows.size).toBe(0);
    // both PRs got fresh check runs
    expect(fx.calls.some((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"))).toBe(true);
    expect(fx.calls.some((c) => c.method === "POST" && c.url.endsWith("/repos/metanorma/isodoc/check-runs"))).toBe(true);
  });

  it("an empty queue drains as done", async () => {
    const db = memoryD1();
    const out = (await drainSweepStep(envOf(db), fx.fetcher)) as { done?: boolean };
    expect(out.done).toBe(true);
  });

  it("the ops route sweeps one bounded step (auth-gated, audited)", async () => {
    const db = memoryD1();
    db.prepare("INSERT INTO sweep_queue (login, queued_at, attempts, cursor) VALUES (?, ?, 0, NULL)").bind("stranger", new Date().toISOString()).run();
    fx.routes.set("/app/installations", () => Response.json({ installations: [] }, { status: 200 }));
    const app = createApp({ ...envOf(db), OPS_TOKEN: "ops-tok" } as never, { fetcher: fx.fetcher });
    const naked = await app.request("/admin/sweep", { method: "POST" });
    expect(naked.status).toBe(403);
    const ok = await app.request("/admin/sweep", { method: "POST", headers: { authorization: "Bearer ops-tok" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Record<string, unknown>)["drained"]).toBe("stranger");
  });
});
