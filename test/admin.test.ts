import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { makeFixture, makeKeyPem, type Fixture } from "./helpers";
import { GENERATED_CONFIG } from "../src/generated/config";

const memoryD1 = () => {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    prepare(sql: string) {
      return {
        bind: (...v: unknown[]) => ({
          run: async () => {
            if (sql.startsWith("INSERT INTO audit_log")) rows.push({ id: v[0], at: v[1], actor: v[2], action: v[3], target: v[4], detail: v[5] });
            if (sql.startsWith("INSERT INTO join_requests")) rows.push({ id: v[0], ocla_id: v[1], login: v[2], ribose_sub: v[3], email: v[4], requested_at: v[5], status: "pending" });
          },
          all: async <T>() => ({ results: (sql.includes("audit_log") ? rows.filter((r) => r["action"]) : []) as T[] }),
          first: async <T>() => (sql.includes("join_requests") ? (rows.find((r) => r["id"] === v[0] && r["status"] === "pending") as T) ?? null : null),
        }),
      };
    },
  };
};

const SCAN = "MTG AG signed CLA scan bytes";
const SCAN_SHA = await (async () => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SCAN));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
})();

let pem: string;
let fx: Fixture;
let db: ReturnType<typeof memoryD1>;

const app = () =>
  createApp({ OPS_TOKEN: "ops-tok", OIDC_CLIENT_SECRET: "op-secret", GITHUB_APP_CLIENT_ID: "Iv1.client", GITHUB_APP_CLIENT_SECRET: "gh-secret", GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem, WEBHOOK_SECRET: "w", DB: db as unknown as D1Database }, { fetcher: fx.fetcher });
const post = (path: string, body: Record<string, unknown>, auth = true) =>
  app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer ops-tok" } : {}) },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
  db = memoryD1();
  fx.routes.set("/repos/example-org/cla-offline/contents/mtg/2026-03-01-ccla.pdf", () =>
    Response.json({ content: Buffer.from(SCAN).toString("base64"), encoding: "base64" }, { status: 200 }),
  );
});

describe("staff console posture", () => {
  it("fail-closed: no ops token -> the console does not exist; bad token -> 403", async () => {
    const naked = createApp({ GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem }, { fetcher: fx.fetcher });
    expect((await naked.request("/admin/void", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(404);
    expect((await post("/admin/void", { target_id: "x", reason: "y" }, false)).status).toBe(403);
  });
});

describe("voidance", () => {
  it("a void record lands and the kernel reads the voided ocla as uncovered", async () => {
    const res = await post("/admin/void", { target_id: "ocla-mtg", reason: "company disputed the agreement" });
    expect(res.status).toBe(200);
    const put = fx.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/revocation/"));
    const record = JSON.parse(Buffer.from((put!.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>;
    expect(record["target"]).toEqual({ id: "ocla-mtg" });
    expect(db.rows.some((r) => r["action"] === "void")).toBe(true);
  });
});

describe("backfill imports", () => {
  const evidence = { path: "mtg/2026-03-01-ccla.pdf", sha256: SCAN_SHA };

  it("evidence mismatch fails closed with the reason", async () => {
    const res = await post("/admin/backfill-ocla", {
      evidence: { path: "mtg/2026-03-01-ccla.pdf", sha256: "deadbeef" },
      org_slug: "mtg-ag",
      covered: [{ githubLogin: "TJ-91" }, { githubLogin: "falko-strenzke" }],
      poc: { email: "poc@mgt.example" },
      signed_at: "2026-03-01",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toContain("hash mismatch");
  });

  it("the MTG-AG-shaped import lands: source backfill, past included, evidence pointer verified, PoC invite returned", async () => {
    const res = await post("/admin/backfill-ocla", {
      evidence,
      org_slug: "mtg-ag-backfilled",
      covered: [{ githubLogin: "TJ-91", name: "Johannes Roth" }, { githubLogin: "falko-strenzke", name: "Falko Strenzke" }],
      signatory: { name: "Signatory", githubLogin: null },
      poc: { name: "P", email: "poc@mgt.example", phone: "+49" },
      domains: ["mtg.example", "mgt.example"],
      signed_at: "2026-03-01",
      note: "executed agreement of 2026-03-01",
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["evidenceVerified"]).toBe(true);
    const record = fx.calls
      .filter((c) => c.method === "PUT" && c.url.includes("/contents/ocla/"))
      .map((c) => JSON.parse(Buffer.from((c.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>)[0]!;
    expect(record["source"]).toBe("backfill");
    expect(record["pastContributionsIncluded"]).toBe(true);
    expect(record["evidence"]).toEqual({ repo: GENERATED_CONFIG.github.offlineRepo, path: evidence.path, sha256: SCAN_SHA });
    expect((record["covered"] as Array<Record<string, unknown>>).map((r) => r["githubLogin"])).toEqual(["tj-91", "falko-strenzke"]);
    expect((out["pocEnrollmentUrl"] as string)).toContain("/enroll?t=");
  });

  it("ICLA evidence-backfill lands for hold-outs", async () => {
    const res = await post("/admin/backfill-icla", {
      evidence: { path: "mtg/2026-03-01-ccla.pdf", sha256: SCAN_SHA },
      github_login: "holdout",
      github_id: 42,
      ribose_id_sub: "pending-linking",
      name: "Hold Out",
      email: "h@example.com",
      signed_at: "2026-01-15",
    });
    expect(res.status).toBe(200);
    const record = fx.calls
      .filter((c) => c.method === "PUT" && c.url.includes("/contents/icla/"))
      .map((c) => JSON.parse(Buffer.from((c.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>)[0]!;
    expect(record).toMatchObject({ github_login: "holdout", source: "backfill", past_contributions_included: true });
  });
});

describe("PoC invitation + bypass + audit", () => {
  it("invite-poc returns a token gated on the invited email", async () => {
    const res = await post("/admin/invite-poc", { ocla_id: "ocla-mtg", email: "newpoc@mgt.example" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)["inviteUrl"]).toContain("/enroll?t=");
  });

  it("bypass approval lands the legal mod and records the decision", async () => {
    await post("/admin/approve-request", {}); // no such request -> 404 first
    const res404 = await post("/admin/approve-request", { request_id: "nope" });
    expect(res404.status).toBe(404);
    // seed one
    const seeded = post("/admin/approve-request", { request_id: "req-1" });
    // seed the queue via the portal join surface instead: direct insert through audit fixture
    db.rows.push({ id: "req-1", ocla_id: "ocla-mtg", login: "tj-91", ribose_sub: "sub-1", email: "j@mtg.example", requested_at: "now", status: "pending" });
    const res = await seeded;
    expect(res.status).toBe(200);
    const mod = fx.calls
      .filter((c) => c.method === "PUT" && c.url.includes("/contents/ocla-mod/"))
      .map((c) => JSON.parse(Buffer.from((c.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>)[0]!;
    expect(mod["reason"]).toBe("staff bypass approval");
  });

  it("the audit trail records ops actions", async () => {
    await post("/admin/void", { target_id: "ocla-mtg", reason: "r" });
    const res = await app().request("/admin/audit", { headers: { authorization: "Bearer ops-tok" } });
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries.some((e) => e["action"] === "void")).toBe(true);
  });
});

describe("POST /admin/evaluate — per-step platform report (advisory forks)", () => {
  it("happy path: installation -> pull -> probe -> verdict, every step reported ok", async () => {
    fx.routes.set("/repos/rnpgp/rnp/installation", () => Response.json({ id: 42 }, { status: 200 }));
    const res = await post("/admin/evaluate", { repo: "rnpgp/rnp", pr: 1, probe: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; steps: Array<Record<string, unknown>>; outcome: string };
    expect(body.ok).toBe(true);
    expect(body.steps.map((s) => s["step"])).toEqual(["installation", "pull", "check-run-probe", "evaluate"]);
    expect(body.steps[0]).toMatchObject({ status: 200, ok: true, installation_id: 42 });
    expect(body.steps[1]).toMatchObject({ status: 200, ok: true, head_sha: "abc123" });
    expect(body.steps[2]).toMatchObject({ status: 201, ok: true });
    expect(body.outcome).toContain("missing=1");

    // the probe is a NEUTRAL run; the verdict run carries the kernel's outcome
    const runs = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"));
    expect(runs).toHaveLength(2);
    expect(runs[0]!.body).toMatchObject({ conclusion: "neutral" });
    expect(runs[1]!.body).toMatchObject({ head_sha: "abc123", conclusion: "failure" });
  });

  it("installation lookup fails -> the report names step 1 and stops", async () => {
    fx.routes.set("/repos/rnpgp/rnp/installation", () => Response.json({ message: "no installation" }, { status: 404 }));
    const res = await post("/admin/evaluate", { repo: "rnpgp/rnp", pr: 1, probe: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; steps: Array<Record<string, unknown>>; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("installation lookup failed (404)");
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]).toMatchObject({ step: "installation", status: 404, ok: false });
    // no further platform calls: the report stopped at the wall
    expect(fx.calls.some((c) => c.url.includes("/pulls/"))).toBe(false);
  });

  it("check-run creation refused -> the wall is named for the GitHub Support ticket, and nothing fakes a pass", async () => {
    fx.routes.set("/repos/rnpgp/rnp/installation", () => Response.json({ id: 42 }, { status: 200 }));
    fx.routes.set("/repos/rnpgp/rnp/check-runs", () => Response.json({ message: "Not Found" }, { status: 404 }));
    const res = await post("/admin/evaluate", { repo: "rnpgp/rnp", pr: 1, probe: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; steps: Array<Record<string, unknown>> };
    expect(body.ok).toBe(false);
    const probe = body.steps.find((s) => s["step"] === "check-run-probe")!;
    expect(probe).toMatchObject({ status: 404, ok: false });
    expect(String(probe["note"])).toContain("GitHub Support");
    // the evaluation never ran: no verdict attempt, no comment
    expect(body.steps.find((s) => s["step"] === "evaluate")).toMatchObject({ ok: false });
    expect(fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs"))).toHaveLength(1);
    expect(fx.calls.some((c) => /\/issues\/\d+\/comments$/.test(c.url) && c.method === "POST")).toBe(false);
  });
});
