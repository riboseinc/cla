import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { makeFixture, makeKeyPem, pullRequestPayload, signedBody, WEBHOOK_SECRET, type Fixture } from "./helpers";
import { resetStaffCache } from "../src/identity/staff";

/**
 * Staff/contractor resolution through a FIXTURE identity service: the
 * subject-roles endpoint, the LINK record, the staff/contractor
 * boundary, and every fail-closed posture.
 */

const ENV = (pem: string, over: Record<string, unknown> = {}) => ({
  OIDC_CLIENT_SECRET: "op-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "gh-secret",
  GITHUB_APP_ID: "1",
  APP_PRIVATE_KEY: pem,
  WEBHOOK_SECRET,
  ...over,
});

let pem: string;
let fx: Fixture;
let identityCalls: string[];

beforeEach(async () => {
  resetStaffCache();
  pem = await makeKeyPem();
  fx = makeFixture();
  identityCalls = [];
  // a LINK record: ronald-t's handle is bound to identity subject staff-sub (github id 777)
  fx.routes.set("/repos/example-org/cla-data/contents/link/2026/11/ronald.json", () =>
    Response.json(
      { content: Buffer.from(JSON.stringify({ id: "link-1", ribose_id_sub: "staff-sub", github_login: "ronald-t", github_id: 777, linked_at: "2026-11-12", source: "portal-dual-flow" })).toString("base64"), encoding: "base64" },
      { status: 200 },
    ),
  );
  fx.routes.set("/repos/example-org/cla-data/git/trees/HEAD", (url, init) => {
    const inm = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"];
    if (inm) return new Response(null, { status: 304, headers: { etag: '"cached"' } });
    return Response.json(
      { tree: [
        { path: "ocla/2026/03/mtg.json", type: "blob" },
        { path: "icla/2026/11/tj.json", type: "blob" },
        { path: "role/2026/11/poc.json", type: "blob" },
        { path: "link/2026/11/ronald.json", type: "blob" },
      ] },
      { status: 200, headers: { etag: '"tree"' } },
    );
  });
  fx.routes.set("/repos/rnpgp/rnp/pulls/1/commits", () =>
    Response.json([{ author: { login: "ronald-t", type: "User" }, commit: { author: { email: "r@example.org" } } }], { status: 200 }),
  );
  fx.fetcher = ((orig) => async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/api/service/subject-roles") {
      identityCalls.push(u.search);
      return Response.json({ account_id: "staff-sub", roles: [{ org: "example-org", role: (u.searchParams.get("id") === "777" ? "staff" : "contractor") }] }, { status: 200 });
    }
    return orig(url, init);
  })(fx.fetcher);
});

const deliver = async (env: Record<string, unknown>) => {
  const app = createApp(ENV(pem, env), { fetcher: fx.fetcher });
  const { body, headers } = await signedBody(WEBHOOK_SECRET, pullRequestPayload());
  return app.request("/api/github/webhook", { method: "POST", body, headers });
};

describe("staff resolution via the identity service", () => {
  it("a staff-role login is covered as staff, resolved through link + subject-roles", async () => {
    const res = await deliver({ SERVICE_TOKEN: "svc-tok" });
    expect(res.status).toBe(200);
    const check = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"));
    expect((check!.body as Record<string, unknown>)["conclusion"]).toBe("success");
    const summary = ((check!.body as Record<string, unknown>)["output"] as Record<string, unknown>)["summary"] as string;
    expect(summary).toContain("staff");
    expect(identityCalls).toHaveLength(1);
    expect(identityCalls[0]).toContain("id=777");
  });

  it("a contractor role falls through to NOT covered — the distinction's whole point", async () => {
    fx.fetcher = ((orig) => async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/service/subject-roles") {
        return Response.json({ account_id: "staff-sub", roles: [{ org: "example-org", role: "contractor" }] }, { status: 200 });
      }
      return orig(url, init);
    })(fx.fetcher);
    await deliver({ SERVICE_TOKEN: "svc-tok" });
    const check = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"));
    expect((check!.body as Record<string, unknown>)["conclusion"]).toBe("failure");
  });

  it("no service token -> no staff path at all (and no identity call)", async () => {
    await deliver({});
    expect(identityCalls).toHaveLength(0);
    const check = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"));
    expect((check!.body as Record<string, unknown>)["conclusion"]).toBe("failure");
  });

  it("an identity-service failure fails closed (unresolved, no staff entry)", async () => {
    fx.fetcher = ((orig) => async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/service/subject-roles") return new Response("boom", { status: 500 });
      return orig(url, init);
    })(fx.fetcher);
    await deliver({ SERVICE_TOKEN: "svc-tok" });
    const check = fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/rnpgp/rnp/check-runs"));
    expect((check!.body as Record<string, unknown>)["conclusion"]).toBe("failure");
  });

  it("role lookups cache per subject (second evaluation = no new identity call)", async () => {
    const env = { SERVICE_TOKEN: "svc-tok" };
    const app = createApp(ENV(pem, env), { fetcher: fx.fetcher });
    const { body, headers } = await signedBody(WEBHOOK_SECRET, pullRequestPayload());
    await app.request("/api/github/webhook", { method: "POST", body, headers });
    const before = identityCalls.length;
    const { body: b2, headers: h2 } = await signedBody(WEBHOOK_SECRET, { ...pullRequestPayload(), action: "synchronize" });
    await app.request("/api/github/webhook", { method: "POST", body: b2, headers: h2 });
    expect(identityCalls.length).toBe(before);
  });
});
