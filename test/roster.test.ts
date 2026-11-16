import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { makeSessionCookie, SESSION_COOKIE, newCsrfToken, CSRF_COOKIE } from "../src/portal/session";
import { makeFixture, makeKeyPem, type Fixture } from "./helpers";

/**
 * The Ribose internal roster (issue #62): a manager-gated live view of
 * the estate's own people. A management grouping only — it never
 * grants coverage; every human still signs like any contributor.
 */

let pem: string;
let fx: Fixture;

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
});

// GENERATED_CONFIG is compiled from the example instance — the roster
// managers live in the example config. The specs read through the real
// compiled config: the manager is whatever cla.example.yaml declares.
import { GENERATED_CONFIG } from "../src/generated/config";
const MANAGER = (GENERATED_CONFIG.instance.rosterManagers ?? [])[0] ?? "example-manager";

const app = () => createApp({
  OIDC_CLIENT_SECRET: "op-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "gh-secret",
  GITHUB_APP_ID: "1",
  APP_PRIVATE_KEY: pem,
  WEBHOOK_SECRET: "w",
}, { fetcher: fx.fetcher });

const authed = async (login: string) => {
  const session = await makeSessionCookie("op-secret", { sub: "s", login, githubId: 1 }, Date.now());
  return { cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${newCsrfToken()}` };
};

describe("the internal roster (issue #62)", () => {
  it("fail-closed: unsigned 401; non-manager 403; a manager reads the live state", async () => {
    const a = app();
    expect((await a.request("/roster")).status).toBe(401);
    expect((await a.request("/roster", { headers: await authed("not-the-boss") })).status).toBe(403);
    const res = await a.request("/roster", { headers: await authed(MANAGER) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { managers: string[]; members: unknown[] };
    expect(body.managers).toContain(MANAGER);
    expect(Array.isArray(body.members)).toBe(true);
  });

  it("a manager adds a member; the member renders with live linked/signed state", async () => {
    const a = app();
    const cookie = await authed(MANAGER);
    const csrf = /cla_csrf=([^;]+)/.exec(cookie.cookie)![1];
    const add = await a.request("/roster/add", {
      method: "POST",
      headers: { cookie: cookie.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: (() => { const b = new URLSearchParams(); b.set("login", "NewStaffer"); b.set("role", "staff"); b.set("name", "New Staffer"); b.set("csrf", csrf ?? ""); return b; })(),
    });
    expect(add.status).toBe(200);
    expect(fx.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/roster/"))).toBe(true);

    // the record the fixture would serve next read: the roster data
    // comes from cla-data; the fixture's trees list does not include the
    // new record, so the read-back needs the tree extended.
    fx.routes.set("/repos/example-org/cla-data/git/trees/HEAD", () =>
      new Response(JSON.stringify({
        tree: [
          { path: "ocla/2026/03/mtg.json", type: "blob" },
          { path: "icla/2026/11/tj.json", type: "blob" },
          { path: "role/2026/11/poc.json", type: "blob" },
          { path: "roster/2026/11/main.json", type: "blob" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    fx.routes.set("/repos/example-org/cla-data/contents/roster/2026/11/main.json", () => {
      const put = fx.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/roster/"));
      const record = JSON.parse(Buffer.from((put!.body as Record<string, unknown>)["content"] as string, "base64").toString());
      return Response.json({ content: Buffer.from(JSON.stringify(record)).toString("base64"), encoding: "base64" }, { status: 200 });
    });
    fx.routes.set("/repos/example-org/cla-data/contents/role/2026/11/poc.json", () =>
      Response.json({ content: Buffer.from(JSON.stringify({ id: "role-poc-1", role: "org_admin", oclaId: "ocla-mtg", riboseSub: "poc-sub", githubLogin: "falko-strenzke", grantedAt: "2026-11-12T00:00:00Z", source: "staff" })).toString("base64"), encoding: "base64" }, { status: 200 }),
    );

    const view = await a.request("/roster", { headers: await authed(MANAGER) });
    const body = (await view.json()) as { members: Array<{ login: string; state: string; linked: boolean }> };
    const member = body.members.find((m) => m.login === "newstaffer");
    expect(member).toBeDefined();
    expect(member!.state).toBe("outstanding");
    expect(member!.linked).toBe(false);
  });

  it("remove drops the member; every mutation is csrf-gated", async () => {
    const a = app();
    const cookie = await authed(MANAGER);
    const csrf = /cla_csrf=([^;]+)/.exec(cookie.cookie)![1];
    await a.request("/roster/add", {
      method: "POST",
      headers: { cookie: cookie.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: (() => { const b = new URLSearchParams(); b.set("login", "TempPerson"); b.set("role", "contractor"); b.set("name", "Temp"); b.set("csrf", csrf ?? ""); return b; })(),
    });
    const bad = await a.request("/roster/remove", {
      method: "POST",
      headers: { cookie: cookie.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login: "tempperson", csrf: "wrong" }),
    });
    expect(bad.status).toBe(403);
    const ok = await a.request("/roster/remove", {
      method: "POST",
      headers: { cookie: cookie.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: (() => { const b = new URLSearchParams(); b.set("login", "tempperson"); b.set("csrf", csrf ?? ""); return b; })(),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Record<string, unknown>)["removed"]).toBe("tempperson");
  });
});
