import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { makeSessionCookie, newCsrfToken, SESSION_COOKIE, CSRF_COOKIE } from "../src/portal/session";
import { loadSnapshot } from "../src/store/load";
import { evaluate, type Config, type Editions, type PrInput, type StoreSnapshot } from "@riboseinc/cla-kernel";
import { makeFixture, makeKeyPem, signedBody, pullRequestPayload, WEBHOOK_SECRET, CURRENT_EDITIONS, type Fixture } from "./helpers";
import { GENERATED_CONFIG } from "../src/generated/config";

/**
 * Verified commit emails (issue #115) — the issue's acceptance, driven
 * through the real app and the real kernel:
 *
 * 1. A contributor adds a second commit email, verifies it through the
 *    portal, pushes an UNLINKED commit from a machine using it: the
 *    check is green, with no manual git config and no second signature.
 * 2. An UNVERIFIED/unknown address still fails honestly, with the
 *    teaching row.
 *
 * The verified email is IDENTITY, never coverage: it binds the commit to
 * a login, and that login's signature still has to exist.
 */

const EDITION = (kind: "icla" | "ocla"): Editions[typeof kind] => {
  const e = GENERATED_CONFIG.legal.editions[kind].find((x) => x.version === GENERATED_CONFIG.legal.current[kind])!;
  return { kind, version: e.version, textSha256: e.sha256 };
};

const EDITIONS: Editions = { icla: EDITION("icla"), ocla: EDITION("ocla") };

const ICLA = (): Record<string, unknown> => ({
  id: "icla-tj",
  githubLogin: "tj-91",
  email: "johannes@mtg.example",
  claEdition: { kind: "icla", version: CURRENT_EDITIONS.icla.version, textSha256: CURRENT_EDITIONS.icla.sha256 },
  pastContributionsIncluded: true,
  source: "portal",
});

const EMAIL_RECORD = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "email-second",
  ribose_id_sub: "ribose-sub-1",
  github_login: "tj-91",
  email: "second@mtg.example",
  verified_at: "2026-11-18T00:00:00Z",
  source: "portal-email-loop",
  ...over,
});

const ENV = (pem: string, extra: Record<string, unknown> = {}) => ({
  OIDC_CLIENT_SECRET: "op-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "gh-secret",
  GITHUB_APP_ID: "1",
  APP_PRIVATE_KEY: pem,
  WEBHOOK_SECRET,
  ...extra,
});

/** Point the data-repo routes at exactly these records. */
function dataRepo(fx: Fixture, files: Record<string, unknown>): void {
  const paths = Object.keys(files);
  fx.routes.set("/repos/example-org/cla-data/git/trees/HEAD", () =>
    Response.json(
      { tree: paths.map((path) => ({ path, type: "blob" })) },
      { status: 200, headers: { etag: `"tree-${paths.sort().join("|")}"` } },
    ),
  );
  for (const path of paths) {
    fx.routes.set(`/repos/example-org/cla-data/contents/${path}`, () =>
      Response.json({ content: Buffer.from(JSON.stringify(files[path])).toString("base64"), encoding: "base64" }, { status: 200 }),
    );
  }
}

const unlinkedCommits = (fx: Fixture, email: string): void => {
  fx.routes.set("/repos/rnpgp/rnp/pulls/1/commits", () =>
    Response.json([{ sha: "a", author: null, commit: { author: { email } } }], { status: 200 }),
  );
};

async function runWebhook(fx: Fixture, pem: string) {
  const app = createApp(ENV(pem), { fetcher: fx.fetcher });
  const { body, headers } = await signedBody(WEBHOOK_SECRET, pullRequestPayload());
  const res = await app.request("/api/github/webhook", { method: "POST", body, headers });
  expect(res.status).toBe(200);
  const check = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
  const comment = fx.calls.find((c) => c.method === "POST" && /\/issues\/1\/comments$/.test(new URL(c.url).pathname));
  return { check: check?.body as Record<string, unknown>, comment: comment?.body as Record<string, unknown> | undefined };
}

// ---- the verification challenge's D1 table (operational state only) ----

const memoryD1 = () => {
  const challenges: Record<string, unknown>[] = [];
  const sweeps: string[] = [];
  return {
    challenges,
    sweeps,
    prepare(sql: string) {
      return {
        bind: (...v: unknown[]) => ({
          run: async () => {
            if (sql.startsWith("INSERT INTO email_challenges")) {
              challenges.push({
                id: v[0], token_hash: v[1], ribose_sub: v[2], login: v[3], email: v[4],
                created_at: v[5], expires_at: v[6], consumed_at: null,
              });
            } else if (sql.startsWith("UPDATE email_challenges")) {
              const row = challenges.find((r) => r["id"] === v[1]);
              if (row && !row["consumed_at"]) row["consumed_at"] = v[0];
            } else if (sql.startsWith("INSERT INTO sweep_queue")) {
              sweeps.push(String(v[0]));
            }
          },
          all: async <T>() => ({ results: [] as T[] }),
          first: async <T>() => {
            if (sql.startsWith("SELECT * FROM email_challenges")) {
              const row = challenges.find(
                (r) => r["token_hash"] === v[0] && !r["consumed_at"] && String(r["expires_at"]) > String(v[1]),
              );
              return (row as T) ?? null;
            }
            if (sql.startsWith("SELECT id, consumed_at FROM email_challenges")) {
              const row = challenges.find((r) => r["id"] === v[0]);
              return (row ? ({ id: row["id"], consumed_at: row["consumed_at"] } as T) : null);
            }
            return null;
          },
        }),
      };
    },
  };
};

const KERNEL_CONFIG: Config = { coverage: { allowlist: { global: [], perOrg: {} } } };
const pr = (committers: PrInput["committers"]): PrInput => ({ context: { org: "rnpgp", repo: "rnp", pr: 1 }, committers });
const snapshot = (over: Partial<StoreSnapshot> = {}): StoreSnapshot => ({ iclas: [], oclas: [], revokedIds: [], ...over });

let pem: string;
beforeEach(async () => {
  pem = await makeKeyPem();
});

describe("acceptance 1: a verified second commit email turns the check green", () => {
  it("portal loop writes the binding, then an unlinked commit from it passes under the existing ICLA", async () => {
    const db = memoryD1();
    const sent: Array<{ to: string; text?: string }> = [];
    const fx = makeFixture();
    const app = createApp(
      ENV(pem, { DB: db as unknown as D1Database, EMAIL: { send: async (m: { to: string; text?: string }) => { sent.push(m); } } }),
      { fetcher: fx.fetcher },
    );

    const sub = "ribose-sub-1";
    const session = await makeSessionCookie(
      "op-secret",
      { sub, login: "tj-91", githubId: 918273, email: "johannes@mtg.example", emailVerified: true },
      Date.now(),
    );
    const csrf = newCsrfToken();
    const cookie = `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`;

    // Add the second address. Addresses normalize: the record and the
    // mail both carry the lowercased form the git author will use.
    const requested = await app.request("/agreements/emails", {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf, email: "Second@MTG.example" }),
    });
    expect(requested.status).toBe(200);
    expect(await requested.json()).toMatchObject({ requested: true, delivered: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("second@mtg.example");

    // The mail proves the mailbox; the portal writes the append-only record.
    const token = /[?&]t=([^\s]+)/.exec(sent[0]!.text ?? "")![1]!;
    // The table holds only a hash: a database leak yields no usable link.
    expect(db.challenges).toHaveLength(1);
    expect(db.challenges[0]!["token_hash"]).not.toBe(token);
    expect(String(db.challenges[0]!["token_hash"])).toMatch(/^[0-9a-f]{64}$/);
    const verified = await app.request(`/agreements/emails/verify?t=${encodeURIComponent(token)}`, { headers: { cookie } });
    expect(verified.status).toBe(303);
    expect(verified.headers.get("location")).toContain("commit_email=verified");

    const emailPuts = () => fx.calls.filter((c) => c.method === "PUT" && c.url.includes("/contents/email/"));
    expect(emailPuts()).toHaveLength(1);
    const emailPath = emailPuts()[0]!.url.split("/contents/")[1]!;
    const record = JSON.parse(Buffer.from((emailPuts()[0]!.body as Record<string, unknown>)["content"] as string, "base64").toString("utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ ribose_id_sub: sub, github_login: "tj-91", email: "second@mtg.example", source: "portal-email-loop" });
    expect(db.sweeps).toContain("tj-91");

    // Replaying the one-time link changes nothing.
    const replay = await app.request(`/agreements/emails/verify?t=${encodeURIComponent(token)}`, { headers: { cookie } });
    expect(replay.headers.get("location")).toContain("commit_email=invalid");
    expect(emailPuts()).toHaveLength(1);

    // The written record is now part of the data repo: a repeat request
    // is idempotent (no duplicate record, no second mail).
    dataRepo(fx, { "icla/2026/11/tj.json": ICLA(), [emailPath]: record });
    const repeat = await app.request("/agreements/emails", {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf, email: "second@mtg.example" }),
    });
    expect(await repeat.json()).toMatchObject({ requested: true, alreadyVerified: true });
    expect(sent).toHaveLength(1);
    expect(emailPuts()).toHaveLength(1);

    // THE ACCEPTANCE: the same contributor's commit from a machine whose
    // address GitHub cannot link is green — via the ICLA they already
    // signed, with no second signature and no git configuration.
    const enf = makeFixture();
    dataRepo(enf, { "icla/2026/11/tj.json": ICLA(), [emailPath]: record });
    unlinkedCommits(enf, "second@mtg.example");
    const { check } = await runWebhook(enf, pem);

    expect(check).toMatchObject({ conclusion: "success" });
    expect(JSON.stringify(check["output"])).toContain("@tj-91 — covered via **icla**");
    expect(enf.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/icla/"))).toBe(false);
  });

  it("the /agreements view lists the verified commit emails", async () => {
    const fx = makeFixture();
    dataRepo(fx, { "email/2026/11/second.json": EMAIL_RECORD() });
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    const session = await makeSessionCookie("op-secret", { sub: "ribose-sub-1", login: "tj-91", githubId: 918273 }, Date.now());
    const res = await app.request("/agreements", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      commitEmails: [{ email: "second@mtg.example", verifiedAt: "2026-11-18T00:00:00Z" }],
    });
  });
});

describe("acceptance 2: an unverified unknown address still fails honestly", () => {
  it("no verified binding: the unlinked commit fails and the teaching row names the address and the portal", async () => {
    const fx = makeFixture();
    // The contributor is covered under their account address; the commit
    // carries an address no one verified — identity is NOT assumed.
    dataRepo(fx, { "icla/2026/11/tj.json": ICLA() });
    unlinkedCommits(fx, "unknown@proton.example");
    const { check, comment } = await runWebhook(fx, pem);

    expect(check).toMatchObject({ conclusion: "failure" });
    const summary = JSON.stringify(check["output"]);
    expect(summary).toContain("author email unknown@proton.example — the commit's author email is not linked to any GitHub account");
    expect(summary).toContain("/agreements");
    expect(JSON.stringify(comment)).toContain("Verify this address once as a [commit email]");
  });

  it("the email record is the only proof: a PENDING challenge is not a verified binding", async () => {
    // Nothing in D1 reaches the kernel: only an `email/` record in the
    // data repo does. A request that was never confirmed leaves no record.
    const v = evaluate(pr([{ login: null, email: "second@mtg.example" }]), snapshot({ iclas: [{ id: "icla-tj", githubLogin: "tj-91", email: "johannes@mtg.example", edition: EDITIONS.icla }] }), KERNEL_CONFIG, EDITIONS);
    expect(v.verdict).toBe("fail");
    expect(v.committers[0]).toMatchObject({ status: "missing", email: "second@mtg.example" });
    expect(v.missing).toEqual(["email:second@mtg.example"]);
  });
});

describe("the verified email is identity, never coverage", () => {
  it("an uncovered login's verified address resolves the committer to that login and still fails", () => {
    const v = evaluate(
      pr([{ login: null, email: "second@mtg.example" }]),
      snapshot({ verifiedEmails: [{ login: "tj-91", email: "second@mtg.example" }] }),
      KERNEL_CONFIG,
      EDITIONS,
    );
    expect(v.verdict).toBe("fail");
    expect(v.committers[0]).toMatchObject({ login: "tj-91", status: "missing" });
    expect(v.missing).toEqual(["tj-91"]);
  });

  it("an address claimed by two logins resolves to nobody — fail closed, name the email", () => {
    const v = evaluate(
      pr([{ login: null, email: "shared@mtg.example" }]),
      snapshot({
        iclas: [
          { id: "icla-a", githubLogin: "a", edition: EDITIONS.icla },
          { id: "icla-b", githubLogin: "b", edition: EDITIONS.icla },
        ],
        verifiedEmails: [
          { login: "a", email: "shared@mtg.example" },
          { login: "b", email: "shared@mtg.example" },
        ],
      }),
      KERNEL_CONFIG,
      EDITIONS,
    );
    expect(v.verdict).toBe("fail");
    expect(v.committers[0]).toMatchObject({ login: null, status: "missing", email: "shared@mtg.example" });
  });

  it("an OCLA-covered login works the same way, and the allowlist applies to the resolved login", () => {
    const viaOcla = evaluate(
      pr([{ login: null, email: "second@mtg.example" }]),
      snapshot({
        oclas: [{ id: "ocla-mtg", orgSlug: "mtg-ag", covered: [{ githubLogin: "tj-91" }], edition: EDITIONS.ocla }],
        verifiedEmails: [{ login: "tj-91", email: "second@mtg.example" }],
      }),
      KERNEL_CONFIG,
      EDITIONS,
    );
    expect(viaOcla.verdict).toBe("pass");
    expect(viaOcla.committers[0]).toMatchObject({ login: "tj-91", status: "covered", path: "ocla", matchedBy: "email" });

    const viaAllowlist = evaluate(
      pr([{ login: null, email: "second@mtg.example" }]),
      snapshot({ verifiedEmails: [{ login: "tj-91", email: "second@mtg.example" }] }),
      { coverage: { allowlist: { global: ["tj-91"], perOrg: {} } } },
      EDITIONS,
    );
    expect(viaAllowlist.committers[0]).toMatchObject({ login: "tj-91", status: "covered", path: "allowlist" });
  });
});

describe("the store fold: revoked and duplicate email records", () => {
  const lister = (files: Record<string, unknown>) => ({
    listRecords: async () => ({
      paths: Object.keys(files).sort(),
      read: async (p: string) => JSON.stringify(files[p]),
    }),
  });

  it("a revocation retires the binding: the commit goes back to failing", async () => {
    const files = {
      "email/2026/11/second.json": EMAIL_RECORD(),
      "revocation/2026/11/rev-1.json": { id: "rev-1", target: { id: "email-second" }, reason: "address retired" },
    };
    const { snapshot: snap, emails, rejected } = await loadSnapshot(lister(files), EDITIONS);
    expect(rejected).toEqual([]);
    expect(emails).toEqual([]);
    expect(snap.verifiedEmails).toEqual([]);

    const v = evaluate(pr([{ login: null, email: "second@mtg.example" }]), { ...snap, iclas: [{ id: "icla-tj", githubLogin: "tj-91", edition: EDITIONS.icla }] }, KERNEL_CONFIG, EDITIONS);
    expect(v.verdict).toBe("fail");
    expect(v.missing).toEqual(["email:second@mtg.example"]);
  });

  it("duplicates of the same (login, email) collapse latest-wins", async () => {
    const files = {
      "email/2026/11/first.json": EMAIL_RECORD({ id: "email-a", verified_at: "2026-11-18T00:00:00Z" }),
      "email/2026/11/second.json": EMAIL_RECORD({ id: "email-b", verified_at: "2026-11-19T00:00:00Z" }),
    };
    const { snapshot: snap, emails } = await loadSnapshot(lister(files), EDITIONS);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ id: "email-b", verifiedAt: "2026-11-19T00:00:00Z" });
    expect(snap.verifiedEmails).toEqual([{ login: "tj-91", email: "second@mtg.example" }]);
  });
});

describe("the portal loop is fail-closed", () => {
  it("unsigned, CSRF-less, malformed, and DB-less requests all refuse honestly", async () => {
    const fx = makeFixture();
    const db = memoryD1();
    const armed = createApp(ENV(pem, { DB: db as unknown as D1Database }), { fetcher: fx.fetcher });
    const session = await makeSessionCookie("op-secret", { sub: "s", login: "tj-91", githubId: 1 }, Date.now());
    const csrf = newCsrfToken();

    expect((await armed.request("/agreements/emails", { method: "POST", body: new URLSearchParams({ csrf, email: "a@b.example" }) })).status).toBe(401);
    expect((await armed.request("/agreements/emails", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${session}` }, body: new URLSearchParams({ csrf, email: "a@b.example" }) })).status).toBe(403);
    expect(
      (await armed.request("/agreements/emails", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}` },
        body: new URLSearchParams({ csrf, email: "not-an-address" }),
      })).status,
    ).toBe(400);

    const dbLess = createApp(ENV(pem), { fetcher: fx.fetcher });
    const noDb = await dbLess.request("/agreements/emails", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}` },
      body: new URLSearchParams({ csrf, email: "a@b.example" }),
    });
    expect(noDb.status).toBe(503);
  });

  it("the verify link needs the session that asked, and an unknown token never writes", async () => {
    const fx = makeFixture();
    const db = memoryD1();
    const app = createApp(ENV(pem, { DB: db as unknown as D1Database }), { fetcher: fx.fetcher });

    const anonymous = await app.request("/agreements/emails/verify?t=whatever");
    expect(anonymous.headers.get("location")).toContain("commit_email=signin");

    const session = await makeSessionCookie("op-secret", { sub: "someone-else", login: "other", githubId: 2 }, Date.now());
    const wrongSub = await app.request("/agreements/emails/verify?t=whatever", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
    expect(wrongSub.headers.get("location")).toContain("commit_email=invalid");

    const unknown = await app.request("/agreements/emails/verify?t=never-issued", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
    expect(unknown.headers.get("location")).toContain("commit_email=invalid");
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/email/"))).toBe(false);
  });
});
