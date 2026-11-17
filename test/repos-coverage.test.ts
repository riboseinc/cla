import { describe, expect, it, beforeEach } from "vitest";
import type { Config, Editions, StoreSnapshot } from "@riboseinc/cla-kernel";
import { createApp } from "../src/app";
import { repoRow } from "../src/enforcement/report";
import { makeFixture, makeKeyPem, CURRENT_EDITIONS, type Fixture } from "./helpers";

/**
 * The repo-centric coverage report (issue #88): repos x people x state.
 * The kernel stays the only authority on coverage; the report adds the
 * operator's view — who contributes, and what each person's live state is.
 *
 * The state table is exercised against `repoRow` with plain snapshots:
 * the snapshot loader's HTTP/ETag caching is not what this file is about,
 * and depending on it would make these assertions order-sensitive.
 */

const EDITIONS: Editions = {
  icla: { kind: "icla", version: CURRENT_EDITIONS.icla.version, textSha256: CURRENT_EDITIONS.icla.sha256 },
  ocla: { kind: "ocla", version: CURRENT_EDITIONS.ocla.version, textSha256: CURRENT_EDITIONS.ocla.sha256 },
};

const snap = (over: Partial<StoreSnapshot> = {}): StoreSnapshot => ({ iclas: [], oclas: [], revokedIds: [], ...over });

const icla = (over: Partial<StoreSnapshot["iclas"][number]> = {}): StoreSnapshot["iclas"][number] => ({
  id: "icla-tj",
  githubLogin: "tj-91",
  email: "johannes@mtg.example",
  edition: EDITIONS.icla,
  ...over,
});

const ocla = (over: Partial<StoreSnapshot["oclas"][number]> = {}): StoreSnapshot["oclas"][number] => ({
  id: "ocla-mtg",
  orgSlug: "mtg-ag",
  covered: [{ githubLogin: "falko-strenzke", email: "falko@mtg.example" }],
  edition: EDITIONS.ocla,
  ...over,
});

const cfg = (allowlist: { global?: string[]; perOrg?: Record<string, string[]> } = {}): Config =>
  ({ coverage: { allowlist: { global: ["dependabot[bot]"], perOrg: {}, ...allowlist } } }) as Config;

const commit = (login: string | null, email: string, date = "2026-11-01T00:00:00Z", type = "User") => ({
  sha: `sha-${login ?? email}`,
  author: login ? { login, type } : null,
  commit: { author: { email, date } },
});

describe("repos-coverage: the person table", () => {
  it("maps kernel coverage to the roster's state words", () => {
    const row = repoRow(
      "org/repo",
      true,
      [
        commit("falko-strenzke", "falko@mtg.example"),
        commit("stranger", "s@x.example"),
        commit("dependabot[bot]", "bot@x.example", "2026-11-01T00:00:00Z", "Bot"),
        commit("estate-release-manager", "rm@x.example"),
      ],
      snap({ oclas: [ocla()] }),
      cfg({ perOrg: { org: ["estate-release-manager"] } }),
      EDITIONS,
      25,
    );
    const by = (l: string) => row.contributors.find((c) => c.login === l);
    expect(by("falko-strenzke")).toMatchObject({ state: "signed", path: "ocla", edition: CURRENT_EDITIONS.ocla.version });
    expect(by("stranger")).toMatchObject({ state: "outstanding" });
    expect(by("dependabot[bot]")).toMatchObject({ state: "ci-account" });
    expect(by("estate-release-manager")).toMatchObject({ state: "allowlist" });
  });

  it("a signature on an older edition reads stale, not outstanding", () => {
    const stale = snap({ iclas: [icla({ edition: { kind: "icla", version: "0.9", textSha256: "older-sha" } })] });
    const row = repoRow("org/repo", true, [commit("tj-91", "johannes@mtg.example"), commit("stranger", "s@x.example")], stale, cfg(), EDITIONS, 25);
    expect(row.contributors.find((c) => c.login === "tj-91")).toMatchObject({ state: "stale" });
    expect(row.contributors.find((c) => c.login === "stranger")).toMatchObject({ state: "outstanding" });
  });

  it("an OCLA row names which organization covers the person; an ICLA row names none", () => {
    const both = snap({
      iclas: [icla()],
      oclas: [
        ocla({ id: "ocla-mtg", orgSlug: "mtg-ag", covered: [{ githubLogin: "falko-strenzke", email: "falko@mtg.example" }] }),
        ocla({ id: "ocla-acme", orgSlug: "acme", covered: [{ githubLogin: "acme-dev", email: "dev@acme.example" }] }),
      ],
    });
    const row = repoRow(
      "org/repo",
      true,
      [commit("tj-91", "johannes@mtg.example"), commit("falko-strenzke", "falko@mtg.example"), commit("acme-dev", "dev@acme.example")],
      both,
      cfg(),
      EDITIONS,
      25,
    );
    const by = (l: string) => row.contributors.find((c) => c.login === l);
    // "covered by an OCLA" is not enough for the operator: WHICH OCLA.
    expect(by("falko-strenzke")).toMatchObject({ state: "signed", path: "ocla", org_slug: "mtg-ag" });
    expect(by("acme-dev")).toMatchObject({ state: "signed", path: "ocla", org_slug: "acme" });
    expect(by("tj-91")).toMatchObject({ state: "signed", path: "icla" });
    expect(by("tj-91")?.org_slug).toBeUndefined();
  });

  it("two applicable agreements read must-specify with their options", () => {
    const both = snap({ iclas: [icla()], oclas: [ocla({ covered: [{ githubLogin: "tj-91", email: "johannes@mtg.example" }] })] });
    const row = repoRow("org/repo", true, [commit("tj-91", "johannes@mtg.example")], both, cfg(), EDITIONS, 25);
    expect(row.contributors[0]?.state).toBe("must-specify");
    expect(row.contributors[0]?.options).toHaveLength(2);
  });

  it("a separate-agreement login is flagged while still reading signed", () => {
    const withRegistry = snap({ oclas: [ocla()], msaLogins: ["falko-strenzke"] });
    const row = repoRow("org/repo", true, [commit("falko-strenzke", "falko@mtg.example")], withRegistry, cfg(), EDITIONS, 25);
    expect(row.contributors[0]).toMatchObject({ login: "falko-strenzke", state: "signed", under_separate_agreement: true });
  });

  it("an unlinked committer covered by email reads signed, unmatched reads outstanding", () => {
    const row = repoRow(
      "org/repo",
      true,
      [commit(null, "falko@mtg.example"), commit(null, "unlinked@example.org")],
      snap({ oclas: [ocla()] }),
      cfg(),
      EDITIONS,
      25,
    );
    expect(row.contributors[0]).toMatchObject({ login: null, state: "signed", matched_by: "email" });
    expect(row.contributors[1]).toMatchObject({ login: null, state: "outstanding" });
  });
});

describe("repos-coverage: route posture", () => {
  let pem: string;
  let fx: Fixture;

  beforeEach(async () => {
    pem = await makeKeyPem();
    fx = makeFixture();
  });

  const app = (env: Record<string, unknown> = {}) =>
    createApp({ OPS_TOKEN: "ops-tok", GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem, ...env }, { fetcher: fx.fetcher });

  const get = (query: string, auth: string | null = "ops-tok", env: Record<string, unknown> = {}) =>
    app(env).request(`/admin/repos-coverage${query}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });

  const listRepos = (repos: string[]) =>
    fx.routes.set("/installation/repositories", () =>
      Response.json({ total_count: repos.length, repositories: repos.map((full_name) => ({ full_name })) }, { status: 200 }),
    );

  it("fail-closed: no ops token -> the report does not exist; bad token -> 403; no installation -> 400", async () => {
    const naked = createApp({ GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem }, { fetcher: fx.fetcher });
    expect((await naked.request("/admin/repos-coverage?installation_id=42")).status).toBe(404);
    expect((await get("?installation_id=42", "wrong")).status).toBe(403);
    expect((await get("")).status).toBe(400);
  });

  it("an empty repository is reported with its reason, not as an empty table", async () => {
    listRepos(["org/empty"]);
    fx.routes.set("/repos/org/empty/commits", () => new Response("{}", { status: 409 }));

    const out = (await (await get("?installation_id=42")).json()) as any;
    expect(out.repos[0]).toMatchObject({ repo: "org/empty", in_scope: true, contributors: [] });
    expect(out.repos[0].note).toContain("empty repository");
    expect(out.notes.join(" ")).toContain("administration permission");
  });

  it("a step covers `limit` repos and hands back the cursor", async () => {
    listRepos(["org/a", "org/b"]);
    fx.routes.set("/repos/org/a/commits", () => Response.json([commit("tj-91", "johannes@mtg.example")], { status: 200 }));
    fx.routes.set("/repos/org/b/commits", () => Response.json([commit("stranger", "s@x.example")], { status: 200 }));

    const first = (await (await get("?installation_id=42&limit=1")).json()) as any;
    expect(first.repos).toHaveLength(1);
    expect(first.repos[0].repo).toBe("org/a");
    expect(first.next).toEqual({ page: 1, offset: 1 });
    expect(fx.calls.filter((c) => c.url.includes("/repos/org/b/commits"))).toHaveLength(0);

    const second = (await (await get("?installation_id=42&limit=1&offset=1")).json()) as any;
    expect(second.repos[0].repo).toBe("org/b");
    expect(second.next).toBeNull();
  });
});
