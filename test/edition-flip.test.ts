import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { makeSessionCookie, newCsrfToken, SESSION_COOKIE, CSRF_COOKIE } from "../src/portal/session";
import { CURRENT_EDITIONS, DATA_OCLA, WEBHOOK_SECRET, makeFixture, makeKeyPem, pullRequestPayload, signedBody, type Fixture } from "./helpers";
import { GENERATED_CONFIG } from "../src/generated/config";

/**
 * The edition flip, organization side (issue #123).
 *
 * A flip makes every OCLA executed on the superseded edition stale (the
 * kernel's liveness is edition-based), so an organization's Schedule A
 * coverage disappears and its join queue pauses. Two things must hold:
 *
 * 1. The organization can RE-EXECUTE on the current edition from the
 *    portal. The old instrument is append-only and stays exactly as
 *    executed; the new one is a second record for the same slug.
 * 2. Every slug lookup reads the LIVE record — not whichever record the
 *    listing happens to return first — so the organization comes back.
 *
 * The "duplicate slug" refusal now means "a second LIVE instrument",
 * which is still staff-merge-only.
 */

/** Minimal in-memory D1 fixture implementing exactly the surface src/store/db.ts uses. */
const memoryD1 = () => {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    prepare(sql: string) {
      return {
        bind: (...v: unknown[]) => ({
          run: async () => {
            if (sql.startsWith("INSERT")) {
              rows.push({ id: v[0], ocla_id: v[1], login: v[2], ribose_sub: v[3], email: v[4], requested_at: v[5], status: "pending" });
            }
            return {};
          },
          all: async <T>() => ({ results: rows.filter((r) => r["ocla_id"] === v[0] && r["status"] === "pending") as T[] }),
          first: async <T>() => {
            if (sql.includes("WHERE id = ?")) return (rows.find((r) => r["id"] === v[0]) as T) ?? null;
            return (rows.find((r) => r["ocla_id"] === v[0] && r["login"] === v[1] && r["status"] === "pending") as T) ?? null;
          },
        }),
      };
    },
  };
};

const ENV = (pem: string, db?: ReturnType<typeof memoryD1>) =>
  ({
    OIDC_CLIENT_SECRET: "op-secret",
    GITHUB_APP_CLIENT_ID: "Iv1.client",
    GITHUB_APP_CLIENT_SECRET: "gh-secret",
    GITHUB_APP_ID: "1",
    APP_PRIVATE_KEY: pem,
    WEBHOOK_SECRET,
    DB: db,
  }) as unknown as Env;

const DATA = "/repos/example-org/cla-data";
const MTG_PATH = "/repos/example-org/cla-data/contents/ocla/2026/03/mtg.json";

/** An OCLA executed on a superseded edition covering the named logins. */
const staleOcla = (covered: string[], version = "0.9") => ({
  ...DATA_OCLA(),
  covered: covered.map((login) => ({ githubLogin: login, email: `${login}@mtg.example` })),
  claEdition: { kind: "ocla", version, textSha256: "superseded-sha" },
});

const content = (body: unknown) =>
  Response.json({ content: Buffer.from(JSON.stringify(body)).toString("base64"), encoding: "base64" }, { status: 200 });

let pem: string;
let fx: Fixture;
let db: ReturnType<typeof memoryD1>;
let signatory: string;
let member: string;
let csrf: string;

const app = () => createApp(ENV(pem, db), { fetcher: fx.fetcher });
const signatoryAuth = () => ({ cookie: `${SESSION_COOKIE}=${signatory}; ${CSRF_COOKIE}=${csrf}` });
const memberAuth = () => ({ cookie: `${SESSION_COOKIE}=${member}; ${CSRF_COOKIE}=${csrf}` });
const form = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    csrf,
    org_name: "MTG AG",
    org_address: "Dolivostr. 11, Darmstadt",
    org_country: "Germany",
    domains: "mtg.example, mgt.example",
    signatory_name: "Signatory S",
    signatory_email: "falko@mgt.example",
    signatory_title: "CEO",
    signatory_github: "",
    poc_name: "PoC P",
    poc_email: "poc@mtg.example",
    poc_phone: "+49 000",
    schedule_a: "tj-91 | Johannes Roth | johannes@mtg.example | Senior Dev",
    terms: "on",
    past: "yes",
    ...over,
  });

const writes = (path: string) => fx.calls.filter((c) => (c.method === "PUT" || c.method === "DELETE") && c.url.includes(path));
const putBodies = (ns: string) =>
  fx.calls
    .filter((c) => c.method === "PUT" && c.url.includes(`/contents/${ns}/`))
    .map((c) => JSON.parse(Buffer.from((c.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>);

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
  db = memoryD1();
  signatory = await makeSessionCookie("op-secret", { sub: "poc-sub", login: "falko-strenzke", githubId: 2, email: "falko@mgt.example", emailVerified: true }, Date.now());
  member = await makeSessionCookie("op-secret", { sub: "sub-1", login: "tj-91", githubId: 918273, email: "johannes@mtg.example", emailVerified: true }, Date.now());
  csrf = newCsrfToken();
  fx.routes.set("/users/tj-91", () => Response.json({ login: "tj-91", id: 918273 }, { status: 200 }));
});

describe("re-execution after an edition flip (issue #123)", () => {
  it("a superseded OCLA can be re-executed: a NEW record on the current edition, the old one untouched", async () => {
    fx.routes.set(MTG_PATH, () => content(staleOcla(["tj-91"])));
    const res = await app().request("/sign-ocla", { method: "POST", headers: signatoryAuth(), body: form() });
    expect(res.status).toBe(200);

    const record = putBodies("ocla")[0]!;
    expect(record["orgSlug"]).toBe("mtg-ag");
    expect(record["claEdition"]).toEqual({
      kind: "ocla",
      version: GENERATED_CONFIG.legal.current.ocla,
      textSha256: CURRENT_EDITIONS.ocla.sha256,
    });
    expect((record["id"] as string)).not.toBe("ocla-mtg");

    // Append-only: the superseded instrument is never rewritten or deleted.
    expect(writes("ocla/2026/03/mtg.json")).toHaveLength(0);
  });

  it("a LIVE OCLA still refuses a second live instrument (staff-merge only)", async () => {
    const res = await app().request("/sign-ocla", { method: "POST", headers: signatoryAuth(), body: form() });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toContain("live OCLA");
  });

  it("after re-execution the join queue unpauses and the console reads the live record", async () => {
    fx.routes.set(MTG_PATH, () => content(staleOcla(["tj-91"])));
    expect((await app().request("/organizations/mtg-ag/join", { method: "POST", headers: memberAuth() })).status).toBe(409);

    // The console tells the PoC the instrument is superseded — to the actor
    // who can fix it, not only in pull-request comments.
    const stranded = (await (await app().request("/admin-orgs/mtg-ag", { headers: signatoryAuth() })).json()) as Record<string, unknown>;
    expect((stranded["org"] as Record<string, unknown>)["current"]).toBe(false);

    const executed = await app().request("/sign-ocla", { method: "POST", headers: signatoryAuth(), body: form() });
    expect(executed.status).toBe(200);
    const fresh = putBodies("ocla")[0]!;
    const freshPath = new URL(fx.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/ocla/"))!.url).pathname.replace("/repos/example-org/cla-data/contents", "");

    // The data repo now carries BOTH records for the slug.
    fx.routes.set(`${DATA}/git/trees/HEAD`, () =>
      Response.json(
        {
          tree: [
            { path: "ocla/2026/03/mtg.json", type: "blob" },
            { path: freshPath.replace(/^\//, ""), type: "blob" },
            { path: "icla/2026/11/tj.json", type: "blob" },
            { path: "role/2026/11/poc.json", type: "blob" },
          ],
        },
        { status: 200 },
      ),
    );
    fx.routes.set(`${DATA}/contents${freshPath}`, () => content(fresh));
    // NOTE: the fixture's org_admin role still names the OLD record's id —
    // the console must keep working for the organization's existing admins.

    const join = await app().request("/organizations/mtg-ag/join", { method: "POST", headers: memberAuth() });
    expect(join.status).toBe(200);
    expect(((await join.json()) as Record<string, unknown>)["requested"]).toBe(true);

    const index = (await (await app().request("/admin-orgs", { headers: signatoryAuth() })).json()) as Record<string, unknown>;
    expect((index["organizations"] as Array<Record<string, unknown>>).map((o) => o["slug"])).toContain("mtg-ag");

    const console_ = await app().request("/admin-orgs/mtg-ag", { headers: signatoryAuth() });
    expect(console_.status).toBe(200);
    const org = ((await console_.json()) as Record<string, unknown>)["org"] as Record<string, unknown>;
    expect(org["id"]).toBe(fresh["id"]);
    expect(org["current"]).toBe(true);
    expect((org["edition"] as Record<string, unknown>)["textSha256"]).toBe(CURRENT_EDITIONS.ocla.sha256);
  });
});

describe("the pull request says WHY an organization's member is uncovered (issue #123)", () => {
  it("names the superseded organization agreement, not just 'sign the ICLA'", async () => {
    // stranger is on the Schedule A of an OCLA executed on a superseded edition.
    fx.routes.set(`${DATA}/git/trees/HEAD`, () =>
      Response.json(
        {
          tree: [
            { path: "ocla/2026/03/mtg.json", type: "blob" },
            { path: "icla/2026/11/tj.json", type: "blob" },
          ],
        },
        { status: 200 },
      ),
    );
    fx.routes.set(MTG_PATH, () => content(staleOcla(["stranger"])));
    const webhook = createApp(ENV(pem), { fetcher: fx.fetcher });
    const { body, headers } = await signedBody(WEBHOOK_SECRET, pullRequestPayload());
    await webhook.request("/api/github/webhook", { method: "POST", body, headers });

    const text = (fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/1/comments"))!.body as Record<string, unknown>)["body"] as string;
    expect(text).toContain("You are on the Schedule A of mtg-ag's Organization CLA v0.9, which the current edition v");
    expect(text).toContain("the organization's signatory must re-execute it");
  });

  it("coverage follows the live record when the slug carries both (the flip's steady state)", async () => {
    fx.routes.set(`${DATA}/git/trees/HEAD`, () =>
      Response.json(
        {
          tree: [
            { path: "ocla/2026/03/mtg.json", type: "blob" },
            { path: "ocla/2026/11/mtg-reexecuted.json", type: "blob" },
            { path: "icla/2026/11/tj.json", type: "blob" },
          ],
        },
        { status: 200 },
      ),
    );
    fx.routes.set(MTG_PATH, () => content(staleOcla(["stranger"])));
    fx.routes.set(`${DATA}/contents/ocla/2026/11/mtg-reexecuted.json`, () =>
      content({
        ...DATA_OCLA(),
        id: "ocla-mtg-new",
        orgSlug: "mtg-ag",
        covered: [{ githubLogin: "stranger", email: "stranger@mtg.example" }],
        claEdition: { kind: "ocla", version: CURRENT_EDITIONS.ocla.version, textSha256: CURRENT_EDITIONS.ocla.sha256 },
      }),
    );
    const webhook = createApp(ENV(pem), { fetcher: fx.fetcher });
    const { body, headers } = await signedBody(WEBHOOK_SECRET, pullRequestPayload());
    const res = await webhook.request("/api/github/webhook", { method: "POST", body, headers });
    expect(res.status).toBe(200);

    const check = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/check-runs"))!;
    expect(((check.body as Record<string, unknown>)["conclusion"]) as string).toBe("success");
  });
});
