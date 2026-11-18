import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { makeSessionCookie, SESSION_COOKIE, newCsrfToken, CSRF_COOKIE } from "../src/portal/session";
import { makeFixture, makeKeyPem, type Fixture } from "./helpers";

/**
 * The Ribose internal roster (issue #62): a manager-gated live view of
 * the estate's own people. A management grouping only — the roster grants
 * nothing; a member on the separate-agreement registry is covered by that
 * agreement (issue #100), and everyone else signs like any contributor.
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

  it("a registry member is covered by the existing agreement, never outstanding (issue #100)", async () => {
    const a = app();
    const res = await a.request("/roster", { headers: await authed(MANAGER) });
    const body = (await res.json()) as { members: Array<{ login: string; state: string; covered: boolean }> };
    // The example config lists `example-staff` in BOTH the roster and the
    // separate-agreement registry: the registry is the coverage, so the
    // management view must not read them outstanding.
    const member = body.members.find((m) => m.login === "example-staff");
    expect(member).toMatchObject({ state: "separate-agreement", covered: true });
  });

  it("membership changes are deliberate config PRs: the runtime has no roster write surface", async () => {
    const a = app();
    const cookie = await authed(MANAGER);
    expect((await a.request("/roster/add", { method: "POST", headers: { cookie: cookie.cookie }, body: "login=x" })).status).toBe(404);
    expect((await a.request("/roster/remove", { method: "POST", headers: { cookie: cookie.cookie }, body: "login=x" })).status).toBe(404);
  });
});
