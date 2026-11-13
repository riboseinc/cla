import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { makeSessionCookie, newCsrfToken, SESSION_COOKIE, CSRF_COOKIE } from "../src/portal/session";
import { makeFixture, makeKeyPem, type Fixture } from "./helpers";
import { GENERATED_CONFIG } from "../src/generated/config";
import type { Env } from "../src/env";

const memoryD1 = () => {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    prepare(sql: string) {
      return {
        bind: (...v: unknown[]) => ({
          run: async () => {
            if (sql.startsWith("INSERT INTO join_requests")) rows.push({ id: v[0], ocla_id: v[1], login: v[2], ribose_sub: v[3], email: v[4], requested_at: v[5], status: "pending" });
          },
          all: async <T>() => ({ results: rows.filter((r) => r["ocla_id"] === v[0] && r["status"] === "pending") as T[] }),
          first: async <T>() => (rows.find((r) => r["ocla_id"] === v[0] && r["login"] === v[1] && r["status"] === "pending") as T) ?? null,
        }),
      };
    },
  };
};

const FROM = GENERATED_CONFIG.coverage.notify.from;
let pem: string;
let fx: Fixture;
let mails: { to: string; subject: string }[];

const mailFixture = () => {
  fx.routes.set("/send", (url, init) => {
    const b = JSON.parse(init!.body as string) as { to: string[]; subject: string };
    mails.push({ to: b.to[0]!, subject: b.subject });
    return Response.json({}, { status: 200 });
  });
};

const ENV = (pem: string) => ({
  OIDC_CLIENT_SECRET: "op-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "gh-secret",
  GITHUB_APP_ID: "1",
  APP_PRIVATE_KEY: pem,
  WEBHOOK_SECRET: "w",
  DB: memoryD1() as unknown as D1Database,
  MAIL_PROVIDER_URL: "https://mail.example/send",
  MAIL_PROVIDER_KEY: "mk",
});

let pocSession: string;
let memberSession: string;
let csrfPoc: string;
let csrfMember: string;

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
  mails = [];
  mailFixture();
  pocSession = await makeSessionCookie("op-secret", { sub: "poc-sub", login: "falko-strenzke", githubId: 2, email: "falko@mgt.example", emailVerified: true }, Date.now());
  memberSession = await makeSessionCookie("op-secret", { sub: "sub-1", login: "tj-91", githubId: 918273, email: "johannes@mtg.example", emailVerified: true }, Date.now());
  csrfPoc = newCsrfToken();
  csrfMember = newCsrfToken();
});

describe("notify leg", () => {
  it("a join request mails the PoC of record", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    const res = await app.request("/organizations/mtg-ag/join", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${memberSession}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)["notified"]).toBe(true);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("p@mtg.example"); // from the fixture OCLA's PoC record
    expect(mails[0]!.subject).toContain("mtg-ag");
  });

  it("PoC approval mails the requester the outcome", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    await app.request("/organizations/mtg-ag/join", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${memberSession}` } });
    const pending = (await (await app.request("/admin-orgs/mtg-ag", { headers: { cookie: `${SESSION_COOKIE}=${pocSession}` } })).json()) as { pendingJoinRequests: Array<{ id: string }> };
    mails = []; // clear the join-request mail
    const res = await app.request("/admin-orgs/mtg-ag/decide", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${pocSession}; ${CSRF_COOKIE}=${csrfPoc}` },
      body: new URLSearchParams({ csrf: csrfPoc, request_id: pending.pendingJoinRequests[0]!.id, decision: "approve" }),
    });
    expect(res.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("johannes@mtg.example");
    expect(mails[0]!.subject).toContain("approved");
  });

  it("the digest posture: an org over its threshold gets no per-request mail", async () => {
    const threshold = GENERATED_CONFIG.coverage.notify.digestThreshold;
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    // flood: distinct logins up to the threshold
    for (let i = 0; i < threshold; i++) {
      const s = await makeSessionCookie("op-secret", { sub: `s${i}`, login: `flooder${i}`, githubId: 1000 + i, email: `f${i}@x.example`, emailVerified: true }, Date.now());
      await app.request("/organizations/mtg-ag/join", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${s}` } });
    }
    expect(mails.length).toBeLessThan(threshold); // switched to digest mode
    const floodMail = mails.find((m) => m.subject.includes("flooder"));
    expect(floodMail).toBeUndefined();
  });

  it("no provider configured -> the honest no-op (flows still succeed)", async () => {
    const env: Record<string, unknown> = { ...ENV(pem) };
    delete env.MAIL_PROVIDER_URL;
    delete env.MAIL_PROVIDER_KEY;
    const app = createApp(env as Env, { fetcher: fx.fetcher });
    const res = await app.request("/organizations/mtg-ag/join", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${memberSession}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)["notified"]).toBe(false);
    expect(mails).toHaveLength(0);
  });
});
