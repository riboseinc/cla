import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createApp } from "../src/app";
import { signCompletionToken, readCompletionToken, isAgreeCommand, thirdPartyGate } from "../src/portal/completion";
import { makeSessionCookie, SESSION_COOKIE } from "../src/portal/session";
import { loadSnapshot } from "../src/store/load";
import { GENERATED_CONFIG } from "../src/generated/config";
import type { Editions } from "@riboseinc/cla-kernel";
import { makeFixture, makeKeyPem, WEBHOOK_SECRET, hmacHex, CURRENT_EDITIONS, type Fixture } from "./helpers";

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
  comment: { user: { login: commenter, id: 4242 }, body },
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

/** A D1 stand-in that records every statement with its bound values. */
function memoryDb() {
  const rows: Array<{ sql: string; bind: unknown[] }> = [];
  return {
    prepare: (sql: string) => ({
      bind: (...v: unknown[]) => ({
        run: async () => {
          rows.push({ sql, bind: v });
        },
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    }),
    rows,
  };
}

/** Every record the app wrote to the data repo: path -> decoded JSON. */
function written(): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const call of fx.calls) {
    if (call.method !== "PUT" || !call.url.includes("/contents/")) continue;
    const path = call.url.split("/contents/")[1]!;
    files[path] = JSON.parse(Buffer.from((call.body as Record<string, unknown>)["content"] as string, "base64").toString("utf8"));
  }
  return files;
}

const lastReply = (): string => {
  const reply = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).at(-1);
  return ((reply!.body as Record<string, unknown>)["body"]) as string;
};

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
    // Option B is OFF (issue #9 acceptance): the command never signs by
    // itself — no record lands, the link does.
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/icla/"))).toBe(false);
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

  it("bot comments are ignored; issue commands outside the signature stay PR-only", async () => {
    expect(((await deliverComment(commentPayload("dependabot[bot]", "@ribose-cla agree"))).json() as Promise<Record<string, unknown>>)).resolves.toMatchObject({ ignored: expect.any(String) });
    expect(((await deliverComment(commentPayload("stranger", "@ribose-cla status", false))).json() as Promise<Record<string, unknown>>)).resolves.toMatchObject({ ignored: expect.any(String) });
  });

  it("issue agree with Option B OFF stays dark — nothing recorded", async () => {
    const out = (await (await deliverComment(commentPayload("stranger", "@ribose-cla agree", false))).json()) as Record<string, unknown>;
    expect(out).toMatchObject({ replied: false, reason: expect.stringContaining("not fully-automatic") });
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/icla/"))).toBe(false);
  });
});

// ---- issue #9 / tracker #16 item 3: Option B, fully-automatic comment signing ----

describe("Option B: fully-automatic comment signing (coverage.comment_signing.automatic)", () => {
  const flagWas = GENERATED_CONFIG.coverage.commentSigning.automatic;
  beforeEach(() => {
    GENERATED_CONFIG.coverage.commentSigning.automatic = true;
  });
  afterEach(() => {
    GENERATED_CONFIG.coverage.commentSigning.automatic = flagWas;
  });

  it("the comment itself signs: a GitHub-only record lands, the check re-runs, and the signer is queued for the sweep", async () => {
    const db = memoryDb();
    const a = createApp({ ...ENV(pem), DB: db as unknown as D1Database }, { fetcher: fx.fetcher });
    const raw = JSON.stringify(commentPayload("stranger", "@ribose-cla agree"));
    const sig = await hmacHex(WEBHOOK_SECRET, raw);
    const res = await a.request("/api/github/webhook", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "x-github-event": "issue_comment", "x-hub-signature-256": `sha256=${sig}` },
    });
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({ replied: true, reason: "signed automatically" });

    const put = fx.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/icla/"));
    expect(put).toBeDefined();
    const record = JSON.parse(Buffer.from((put!.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>;
    expect(record).toMatchObject({
      github_login: "stranger",
      github_id: 4242,
      source: "comment-auto",
      past_contributions_included: true,
      claEdition: { kind: "icla", version: CURRENT_EDITIONS.icla.version, textSha256: CURRENT_EDITIONS.icla.sha256 },
    });
    // GitHub-only: nothing the portal would have collected is invented here
    expect(record["ribose_id_sub"]).toBeUndefined();
    expect(record["name"]).toBeUndefined();
    expect(record["country"]).toBeUndefined();

    // the reply states the terms, links the exact instrument, and
    // carries no completion link — the comment already signed
    const text = lastReply();
    expect(text).toContain("@stranger");
    expect(text).toContain("Individual CLA");
    expect(text).toContain("/agreements/text/icla/");
    expect(text).toContain("all your previous contributions");
    expect(text).not.toContain("/icla/complete");

    // the check re-ran on this head, and the signer's other open PRs are
    // queued for the write-back sweep (the same refresh portal signing gets)
    expect(fx.calls.some((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"))).toBe(true);
    expect(db.rows.some((r) => r.sql.includes("sweep_queue") && r.bind[0] === "stranger")).toBe(true);
  });

  it("the automatic record reads back as live coverage for the signer", async () => {
    const res = await deliverComment(commentPayload("stranger", "@ribose-cla agree"));
    expect(((await res.json()) as Record<string, unknown>)["reason"]).toBe("signed automatically");

    const files = written();
    const path = Object.keys(files).find((p) => p.startsWith("icla/"));
    expect(path).toBeDefined();
    const editions: Editions = {
      icla: { kind: "icla", version: CURRENT_EDITIONS.icla.version, textSha256: CURRENT_EDITIONS.icla.sha256 },
      ocla: { kind: "ocla", version: CURRENT_EDITIONS.ocla.version, textSha256: CURRENT_EDITIONS.ocla.sha256 },
    };
    const { snapshot, rejected } = await loadSnapshot(
      { listRecords: async () => ({ paths: Object.keys(files).sort(), read: async (p: string) => JSON.stringify(files[p]) }) },
      editions,
    );
    expect(rejected).toEqual([]);
    expect(snapshot.iclas).toHaveLength(1);
    expect(snapshot.iclas[0]).toMatchObject({ githubLogin: "stranger", edition: editions.icla });
  });

  it("a separate-agreement registry login is told the CLA process does not apply: nothing recorded, no re-check", async () => {
    fx.routes.set("/repos/rnpgp/rnp/pulls/1/commits", () =>
      Response.json([{ author: { login: "example-staff", type: "User" }, commit: { author: { email: "staff@example.org" } } }], { status: 200 }),
    );
    const res = await deliverComment(commentPayload("example-staff", "@ribose-cla agree"));
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({ replied: true, reason: "separate-agreement registry" });
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/icla/"))).toBe(false);
    expect(fx.calls.some((c) => c.method === "POST" && c.url.endsWith("/check-runs"))).toBe(false);
    expect(lastReply()).toContain("existing Ribose agreement");
    expect(lastReply()).not.toContain("/icla/complete");
  });

  it("an already-signed committer is told so instead of signing twice", async () => {
    const res = await deliverComment(commentPayload("tj-91", "@ribose-cla agree"));
    expect(((await res.json()) as Record<string, unknown>)["reason"]).toBe("already-signed");
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/icla/"))).toBe(false);
    expect(lastReply()).not.toContain("/icla/complete");
  });

  // ---- the signature venue's "empty pull request": a plain issue ----

  it("issue agree signs: the record lands, the reply names the instrument, no check runs", async () => {
    const db = memoryDb();
    const a = createApp({ ...ENV(pem), DB: db as unknown as D1Database }, { fetcher: fx.fetcher });
    const raw = JSON.stringify(commentPayload("stranger", "@ribose-cla agree", false));
    const sig = await hmacHex(WEBHOOK_SECRET, raw);
    const res = await a.request("/api/github/webhook", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "x-github-event": "issue_comment", "x-hub-signature-256": `sha256=${sig}` },
    });
    expect(((await res.json()) as Record<string, unknown>)["reason"]).toBe("signed automatically");

    const record = written()[Object.keys(written()).find((p) => p.startsWith("icla/"))!] as Record<string, unknown>;
    expect(record).toMatchObject({ github_login: "stranger", source: "comment-auto", past_contributions_included: true });

    const text = lastReply();
    expect(text).toContain("@stranger");
    expect(text).toContain("Individual CLA");
    expect(text).toContain("/agreements/text/icla/");
    expect(text).toContain("all your previous contributions");

    // issues have no checks: nothing may POST a check run
    expect(fx.calls.some((c) => c.method === "POST" && c.url.endsWith("/check-runs"))).toBe(false);
    // the signer's open PRs (if any) still refresh via the sweep
    expect(db.rows.some((r) => r.sql.includes("sweep_queue") && r.bind[0] === "stranger")).toBe(true);
  });

  it("issue agree from a separate-agreement registry login is refused: nothing recorded", async () => {
    const res = await deliverComment(commentPayload("example-staff", "@ribose-cla agree", false));
    expect(((await res.json()) as Record<string, unknown>)["reason"]).toBe("separate-agreement registry");
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/icla/"))).toBe(false);
    expect(lastReply()).toContain("existing Ribose agreement");
  });

  it("issue agree when already signed answers idempotently", async () => {
    const res = await deliverComment(commentPayload("tj-91", "@ribose-cla agree", false));
    expect(((await res.json()) as Record<string, unknown>)["reason"]).toBe("already-signed");
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/icla/"))).toBe(false);
  });

  it("issue-scoped elections stay PR-only: agree company= is ignored on an issue", async () => {
    const res = await deliverComment(commentPayload("stranger", "@ribose-cla agree company=example-org", false));
    expect(((await res.json()) as Record<string, unknown>)["ignored"]).toBe("not a command on a PR");
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(false);
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

// ---- issues #63 / #118: @ribose-cla third-party: <name> (SPDX: <id>) ----

describe("issue_comment: third-party declaration (issues #63, #118)", () => {
  const thirdPartyPayload = (commenter: string, name: string, spdx = "MIT") =>
    commentPayload(commenter, `@ribose-cla third-party: ${name} (SPDX: ${spdx})`);

  it("a committer's declaration records append-only, with its SPDX id, and replies with the obligations", async () => {
    const res = await deliverComment(thirdPartyPayload("tj-91", "Example Corp"));
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["replied"]).toBe(true);
    expect(out["reason"]).toBe("third-party declaration recorded");

    const put = fx.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/third_party/"));
    expect(put).toBeDefined();
    const record = JSON.parse(Buffer.from((put!.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>;
    expect(record).toMatchObject({ repo: "rnpgp/rnp", pr: 1, login: "tj-91", name: "Example Corp", spdx: "MIT" });

    const reply = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).at(-1);
    const text = (reply!.body as Record<string, unknown>)["body"] as string;
    expect(text).toContain("Submitted on behalf of a third-party: Example Corp (SPDX: MIT)");
    expect(text).toContain("license (MIT)");
    expect(text).toContain("does not replace your own agreement");

    // the conspicuous marking lands in the PR body (clause 7)
    const patch = fx.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/pulls/1"));
    expect(patch).toBeDefined();
    expect(((patch!.body as Record<string, unknown>)["body"] as string)).toContain("Submitted on behalf of a third-party: Example Corp (SPDX: MIT)");
  });

  it("a body that already carries the marking is left alone", async () => {
    fx.routes.set("/repos/rnpgp/rnp/pulls/1", () =>
      Response.json({ head: { sha: "abc123" }, body: "work summary\\n\\nSubmitted on behalf of a third-party: Example Corp (SPDX: MIT)" }, { status: 200 }),
    );
    await deliverComment(thirdPartyPayload("tj-91", "Example Corp"));
    expect(fx.calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/1"))).toBe(false);
  });

  it("a license off the accepted list is refused by name, and nothing is recorded", async () => {
    const res = await deliverComment(thirdPartyPayload("tj-91", "Example Corp", "BUSL-1.1"));
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["replied"]).toBe(true);
    expect(out["reason"]).toBe("SPDX BUSL-1.1 not accepted");
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/third_party/"))).toBe(false);
    const reply = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).at(-1);
    const text = (reply!.body as Record<string, unknown>)["body"] as string;
    expect(text).toContain("not on Ribose's accepted-license list");
    expect(text).toContain("Accepted licenses: BSD-2-Clause, BSD-3-Clause, MIT");
  });

  it("a declaration without an SPDX id is refused with the grammar, and nothing is recorded", async () => {
    const res = await deliverComment(commentPayload("tj-91", "@ribose-cla third-party: Example Corp"));
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["replied"]).toBe(true);
    expect(String(out["reason"])).toContain("malformed third-party declaration");
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/third_party/"))).toBe(false);
    const reply = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).at(-1);
    expect((reply!.body as Record<string, unknown>)["body"] as string).toContain("(SPDX: <identifier>)");
  });

  it("an SPDX expression is refused: the accepted list is a list of identifiers", async () => {
    const res = await deliverComment(thirdPartyPayload("tj-91", "Example Corp", "MIT OR Apache-2.0"));
    const out = (await res.json()) as Record<string, unknown>;
    expect(String(out["reason"])).toContain("malformed third-party declaration");
    const reply = fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments")).at(-1);
    expect((reply!.body as Record<string, unknown>)["body"] as string).toContain("is not a single SPDX identifier");
  });

  it("non-committers are ignored; a declaration never grants coverage (the check still fails without a signature)", async () => {
    const res = await deliverComment(thirdPartyPayload("random-person", "Example Corp"));
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["replied"]).toBe(false);
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/third_party/"))).toBe(false);
  });
});

describe("third-party accepted-license gate (issue #118)", () => {
  it("an unconfigured list fails closed, in different words from an explicit empty list", () => {
    const unset = thirdPartyGate(undefined, "MIT");
    expect(unset).toMatchObject({ allowed: false, reason: "accepted-license list unconfigured" });
    if (!unset.allowed) expect(unset.message).toContain("has not configured");
    const empty = thirdPartyGate([], "MIT");
    expect(empty).toMatchObject({ allowed: false, reason: "no third-party material accepted" });
    if (!empty.allowed) expect(empty.message).toContain("does not currently accept");
  });

  it("matches ids case-insensitively and returns the configured spelling", () => {
    expect(thirdPartyGate(["MIT", "BSD-3-Clause"], "mit")).toEqual({ allowed: true, spdx: "MIT" });
    const no = thirdPartyGate(["MIT"], "BUSL-1.1");
    expect(no).toMatchObject({ allowed: false, reason: "SPDX BUSL-1.1 not accepted" });
  });
});
