import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { makeSessionCookie, newCsrfToken, SESSION_COOKIE, CSRF_COOKIE } from "../src/portal/session";
import { appendRecord } from "../src/store/write";
import { loadSnapshot } from "../src/store/load";
import { GithubApi } from "../src/github/api";
import { makeFixture, makeKeyPem, type Fixture } from "./helpers";
import { GENERATED_CONFIG } from "../src/generated/config";
import type { Editions } from "@riboseinc/cla-kernel";

/**
 * The data-repo write leg and the loader must agree: a record the app
 * writes (portal signing, handle linking, attribution, backfill) has
 * to read back as the same legal fact. Path-only ids and snake_case
 * field names were being rejected as invalid records — i.e. every
 * portal signature silently vanished from enforcement.
 */

const EDITION = (kind: "icla" | "ocla"): Editions[typeof kind] => {
  const e = GENERATED_CONFIG.legal.editions[kind].find((x) => x.version === GENERATED_CONFIG.legal.current[kind])!;
  return { kind, version: e.version, textSha256: e.sha256 };
};

const EDITIONS: Editions = { icla: EDITION("icla"), ocla: EDITION("ocla") };
const ENV = (pem: string) => ({
  OIDC_CLIENT_SECRET: "op-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "gh-secret",
  GITHUB_APP_ID: "1",
  APP_PRIVATE_KEY: pem,
  WEBHOOK_SECRET: "wh",
});

let pem: string;
let fx: Fixture;

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
});

/** The writes the app performed: path (relative to the data repo) -> decoded record. */
function written(): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const call of fx.calls) {
    if (call.method !== "PUT" || !call.url.includes("/contents/")) continue;
    const path = call.url.split("/contents/")[1]!;
    const content = (call.body as Record<string, unknown>)["content"] as string;
    files[path] = JSON.parse(Buffer.from(content, "base64").toString("utf8"));
  }
  return files;
}

const lister = (files: Record<string, unknown>) => ({
  listRecords: async () => ({
    paths: Object.keys(files).sort(),
    read: async (p: string) => JSON.stringify(files[p]),
  }),
});

const api = () =>
  new GithubApi({
    fetcher: fx.fetcher,
    now: () => Date.now(),
    appId: "1",
    privateKeyPem: pem,
    tokenCache: { get: () => "tok", put: () => {} },
    etagCache: { get: () => undefined, put: () => {} },
  });

describe("data-repo round trip", () => {
  it("an ICLA signed at the portal loads back as live coverage", async () => {
    const app = createApp(ENV(pem), { fetcher: fx.fetcher });
    const session = await makeSessionCookie(
      "op-secret",
      { sub: "sub-1", login: "tj-91", githubId: 918273, email: "johannes@mtg.example", emailVerified: true },
      Date.now(),
    );
    const csrf = newCsrfToken();
    const res = await app.request("/icla/sign", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}` },
      body: new URLSearchParams({
        terms: "on",
        past: "yes",
        csrf,
        name: "Johannes Roth",
        email: "johannes@mtg.example",
        country: "Germany",
      }),
    });
    expect(res.status).toBe(200);

    const files = written();
    const iclaPath = Object.keys(files).find((p) => p.startsWith("icla/"));
    expect(iclaPath).toBeDefined();
    // the signing form's full details survive into the record
    expect(files[iclaPath!]).toMatchObject({ name: "Johannes Roth", email: "johannes@mtg.example", country: "Germany" });

    const { snapshot, rejected } = await loadSnapshot(lister(files), EDITIONS);
    expect(rejected).toEqual([]);
    expect(snapshot.iclas).toHaveLength(1);
    expect(snapshot.iclas[0]).toMatchObject({ githubLogin: "tj-91", id: expect.any(String) });
    expect(snapshot.iclas[0]!.edition.textSha256).toBe(EDITIONS.icla.textSha256);
  });

  it("a LINK record written by the portal resolves a staff subject", async () => {
    await appendRecord({ api: api(), installationId: 1, dataRepo: "example-org/cla-data", now: () => Date.now() }, "link", {
      ribose_id_sub: "staff-sub",
      github_login: "ronald-t",
      github_id: 777,
      linked_at: "2026-11-12T00:00:00Z",
      source: "portal-dual-flow",
    });

    const { links, rejected } = await loadSnapshot(lister(written()), EDITIONS);
    expect(rejected).toEqual([]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ riboseSub: "staff-sub", githubLogin: "ronald-t", githubId: 777 });
  });

  it("an attribution election written by the portal resolves must-specify on re-evaluation", async () => {
    await appendRecord({ api: api(), installationId: 1, dataRepo: "example-org/cla-data", now: () => Date.now() }, "attribution", {
      repo: "rnpgp/rnp",
      pr: 1,
      login: "tj-91",
      agreement: { kind: "icla", version: "1.0" },
      recorded_at: "2026-11-12T00:00:00Z",
    });

    const { snapshot, rejected } = await loadSnapshot(lister(written()), EDITIONS);
    expect(rejected).toEqual([]);
    expect(snapshot.attributions).toEqual([
      { repo: "rnpgp/rnp", pr: 1, login: "tj-91", agreement: { kind: "icla", version: "1.0" } },
    ]);
  });

  it("the documented snake_case OCLA schema (design §8) still loads", async () => {
    const files = {
      "ocla/2026/03/mtg-ag.json": {
        id: "ocla-mtg",
        org_slug: "mtg-ag",
        cla_edition: { kind: "ocla", version: "1.0", textSha256: EDITIONS.ocla.textSha256 },
        covered: [{ github_login: "tj-91", email: "johannes@mtg.example" }],
        signatory: { name: "S", email: "s@mtg.example" },
        poc: { name: "P", email: "p@mtg.example" },
        domains: ["mtg.example"],
        past_contributions_included: true,
        source: "backfill",
      },
    };

    const { snapshot, rejected } = await loadSnapshot(lister(files), EDITIONS);
    expect(rejected).toEqual([]);
    expect(snapshot.oclas[0]).toMatchObject({ orgSlug: "mtg-ag", covered: [{ githubLogin: "tj-91" }] });
  });
});
