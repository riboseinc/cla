import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { makeSessionCookie, newCsrfToken, SESSION_COOKIE, CSRF_COOKIE } from "../src/portal/session";
import { signEnrollmentToken, readEnrollmentToken } from "../src/portal/enroll";
import { makeFixture, makeKeyPem, type Fixture } from "./helpers";
import { GENERATED_CONFIG } from "../src/generated/config";

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
            if (sql.startsWith("UPDATE")) {
              const r = rows.find((x) => x["id"] === v[3]);
              if (r) {
                r["status"] = v[0];
                r["decided_by"] = v[1];
                r["decided_at"] = v[2];
              }
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

const ENV = (pem: string, db?: ReturnType<typeof memoryD1>) => ({
  OIDC_CLIENT_SECRET: "op-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "gh-secret",
  GITHUB_APP_ID: "1",
  APP_PRIVATE_KEY: pem,
  WEBHOOK_SECRET: "wh",
  DB: db,
});

const OCLA = GENERATED_CONFIG.legal.current.ocla;
let pem: string;
let fx: Fixture;
let db: ReturnType<typeof memoryD1>;
let pocSession: string;
let memberSession: string;
let csrfPoc: string;
let csrfMember: string;

const app = () => createApp(ENV(pem, db) as Env, { fetcher: fx.fetcher });
const pocAuth = () => ({ cookie: `${SESSION_COOKIE}=${pocSession}; ${CSRF_COOKIE}=${csrfPoc}` });
const memberAuth = () => ({ cookie: `${SESSION_COOKIE}=${memberSession}; ${CSRF_COOKIE}=${csrfMember}` });

const putBodies = (ns: string) =>
  fx.calls
    .filter((c) => c.method === "PUT" && c.url.includes(`/contents/${ns}/`))
    .map((c) => JSON.parse(Buffer.from((c.body as Record<string, unknown>)["content"] as string, "base64").toString()) as Record<string, unknown>);

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
  db = memoryD1();
  pocSession = await makeSessionCookie("op-secret", { sub: "poc-sub", login: "falko-strenzke", githubId: 2, email: "falko@mgt.example", emailVerified: true }, Date.now());
  memberSession = await makeSessionCookie("op-secret", { sub: "sub-1", login: "tj-91", githubId: 918273, email: "johannes@mtg.example", emailVerified: true }, Date.now());
  csrfPoc = newCsrfToken();
  csrfMember = newCsrfToken();
  fx.routes.set("/users/tj-91", () => Response.json({ login: "tj-91", id: 918273 }, { status: 200 }));
  fx.routes.set("/users/new-emp", () => Response.json({ login: "new-emp", id: 555 }, { status: 200 }));
  fx.routes.set("/users/ghost-user", () => new Response("nope", { status: 404 }));
});

describe("OCLA execution (self-service)", () => {
  const form = (over: Record<string, string> = {}) =>
    new URLSearchParams({
      csrf: csrfPoc,
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

  it("fail-closed: the signatory's identity email must be VERIFIED and on a declared domain", async () => {
    const unverified = await makeSessionCookie("op-secret", { sub: "s", login: "x", githubId: 1, email: "someone@else.example", emailVerified: false }, Date.now());
    const res = await app().request("/sign-ocla", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${unverified}; ${CSRF_COOKIE}=csrf` },
      body: form({ csrf: "csrf" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toContain("VERIFIED mailbox on a declared company domain");
  });

  it("a PoC email off the declared domains is rejected", async () => {
    const res = await app().request("/sign-ocla", { method: "POST", headers: pocAuth(), body: form({ poc_email: "outside@evil.example" }) });
    expect(res.status).toBe(400);
  });

  it("an unresolvable Schedule-A username is rejected with the login named", async () => {
    const res = await app().request("/sign-ocla", { method: "POST", headers: pocAuth(), body: form({ schedule_a: "ghost-user | Ghost | g@mtg.example | X" }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toContain("ghost-user");
  });

  it("executes: record lands with resolved lowercase logins + ids, current edition, and the PoC enrollment link", async () => {
    const res = await app().request("/sign-ocla", { method: "POST", headers: pocAuth(), body: form({ org_name: "MTG Holdings" }) });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["orgSlug"]).toBe("mtg-holdings");
    expect(out["coveredCount"]).toBe(1);

    const record = putBodies("ocla")[0]!;
    expect(record["orgSlug"]).toBe("mtg-holdings");
    expect(record["claEdition"]).toEqual({ kind: "ocla", version: OCLA, textSha256: GENERATED_CONFIG.legal.editions.ocla.find((e) => e.version === OCLA)!.sha256 });
    expect(record["covered"]).toEqual([{ githubLogin: "tj-91", githubId: 918273, email: "johannes@mtg.example", name: "Johannes Roth", title: "Senior Dev" }]);
    expect(record["domains"]).toEqual(["mtg.example", "mgt.example"]);
    expect(record["pastContributionsIncluded"]).toBe(true);
    expect(record["source"]).toBe("portal");

    const enrollUrl = out["pocEnrollmentUrl"] as string;
    const token = enrollUrl.split("t=")[1]!;
    expect((await readEnrollmentToken("op-secret", token, Date.now()))?.email).toBe("poc@mtg.example");
  });

  it("a duplicate org slug refuses (staff-merge only)", async () => {
    await app().request("/sign-ocla", { method: "POST", headers: pocAuth(), body: form() });
    expect((await app().request("/sign-ocla", { method: "POST", headers: pocAuth(), body: form() })).status).toBe(400);
  });
});

describe("PoC enrollment", () => {
  it("requires a VERIFIED identity account for the invited email", async () => {
    const token = await signEnrollmentToken("op-secret", "ocla-mtg", "newpoc@mgt.example", Date.now());
    const res = await app().request(`/enroll?t=${token}`, { headers: memberAuth() }); // member's email != invited
    expect(res.status).toBe(403);
  });

  it("a verified match grants the org_admin role record", async () => {
    const token = await signEnrollmentToken("op-secret", "ocla-mtg", "falko@mgt.example", Date.now());
    const res = await app().request(`/enroll?t=${token}`, { headers: pocAuth() });
    expect(res.status).toBe(200);
    const record = putBodies("role")[0]!;
    expect(record).toMatchObject({ role: "org_admin", oclaId: "ocla-mtg", riboseSub: "poc-sub", source: "enrollment" });
  });
});

describe("join flow + PoC console", () => {
  it("an employee requests coverage; one pending per account/org; the PoC approves and the mod lands", async () => {
    const a = app();
    // fixture already carries a staff-granted org_admin role for poc-sub
    const join = await a.request("/organizations/mtg-ag/join", { method: "POST", headers: memberAuth() });
    expect(join.status).toBe(200);
    expect(((await join.json()) as Record<string, unknown>)["requested"]).toBe(true);
    expect((await a.request("/organizations/mtg-ag/join", { method: "POST", headers: memberAuth() })).status).toBe(409);

    const pending = (await (await a.request("/admin-orgs/mtg-ag", { headers: pocAuth() })).json()) as Record<string, unknown>;
    const queue = pending["pendingJoinRequests"] as Array<Record<string, unknown>>;
    expect(queue).toHaveLength(1);
    expect((pending["effectiveScheduleA"] as unknown[]).length).toBeGreaterThanOrEqual(2); // folded fixture Schedule A
    expect((pending["mods"] as unknown[]).length).toBe(0);

    const decide = await a.request("/admin-orgs/mtg-ag/decide", {
      method: "POST",
      headers: pocAuth(),
      body: new URLSearchParams({ csrf: csrfPoc, request_id: String(queue[0]!["id"]), decision: "approve" }),
    });
    expect(decide.status).toBe(200);
    const mod = putBodies("ocla-mod")[0]!;
    expect(mod).toMatchObject({ oclaId: "ocla-mtg", reason: "join-request approval" });
    expect((mod["add"] as Array<Record<string, unknown>>)[0]!["githubLogin"]).toBe("tj-91");
    expect(db.rows[0]!["status"]).toBe("approved");
  });

  it("non-admins cannot see or decide the console; unknown logins 404", async () => {
    const a = app();
    expect((await a.request("/admin-orgs/mtg-ag", { headers: memberAuth() })).status).toBe(403);
    expect((await a.request("/admin-orgs/mtg-ag/decide", { method: "POST", headers: memberAuth(), body: new URLSearchParams({ csrf: csrfMember, request_id: "x", decision: "approve" }) })).status).toBe(403);
    expect(
      (await a.request("/admin-orgs/mtg-ag/remove", { method: "POST", headers: pocAuth(), body: new URLSearchParams({ csrf: csrfPoc, login: "not-there" }) })).status,
    ).toBe(404);
  });

  it("PoC direct add/remove land as append-only mods with live username validation", async () => {
    const a = app();
    const add = await a.request("/admin-orgs/mtg-ag/add", { method: "POST", headers: pocAuth(), body: new URLSearchParams({ csrf: csrfPoc, login: "new-emp", name: "N", email: "n@mtg.example", title: "Dev" }) });
    expect(add.status).toBe(200);
    expect((putBodies("ocla-mod")[0]!["add"] as Array<Record<string, unknown>>)[0]!["githubLogin"]).toBe("new-emp");

    const remove = await a.request("/admin-orgs/mtg-ag/remove", { method: "POST", headers: pocAuth(), body: new URLSearchParams({ csrf: csrfPoc, login: "falko-strenzke" }) });
    expect(remove.status).toBe(200);
    const mod2 = putBodies("ocla-mod")[1]!;
    expect(mod2["removeLogins"]).toEqual(["falko-strenzke"]);
  });
});
