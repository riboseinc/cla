import { describe, expect, it, beforeEach } from "vitest";
import { GithubApi } from "../src/github/api";
import { GENERATED_CONFIG } from "../src/generated/config";
import { evaluateWithOrgMembership, resolveOrgMemberships } from "../src/enforcement/org-membership";
import { evaluatePullRequest, closeMergedPullRequest, handleAgreeCommand, handleMetaCommand } from "../src/enforcement/handler";
import { evaluate } from "@riboseinc/cla-kernel";
import { kernelEditions } from "../src/config";
import type { AppConfig } from "../src/config";
import { makeFixture, makeKeyPem, DATA_OCLA, type Fixture } from "./helpers";

/**
 * Coverage by GitHub-org membership (issue #16 item 4). The kernel
 * matrix lives in packages/kernel/test/evaluate.test.ts; this file
 * covers the transport leg (asking GitHub) and the enforcement
 * surfaces that must state the answer honestly: the check run, the
 * closing attribution, and the comment commands.
 *
 * The design's two rules are asserted here directly:
 *   - membership is resolved ONLY for otherwise-uncovered committers;
 *   - an unverifiable membership fails closed, never guesses.
 */

let pem: string;
let fx: Fixture;

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
});

const tokens = new Map<string, string>();
const makeApi = (): GithubApi =>
  new GithubApi({
    fetcher: fx.fetcher,
    now: () => Date.now(),
    appId: "1",
    privateKeyPem: pem,
    tokenCache: { get: (k) => tokens.get(k), put: (k, v) => void tokens.set(k, v) },
    etagCache: { get: () => undefined, put: () => {} },
  });

/** The example config with org-membership designation switched ON:
 *  members of GitHub org `example-org` are designated under the
 *  fixture's live OCLA (`mtg-ag`). */
const configWithMembership = (): AppConfig => ({
  ...GENERATED_CONFIG,
  coverage: { ...GENERATED_CONFIG.coverage, orgMembership: { "example-org": "mtg-ag" } },
});

const membershipCalls = () => fx.calls.filter((c) => c.url.includes("/orgs/"));
const checkRun = () => fx.calls.find((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
const commentsPosted = () => fx.calls.filter((c) => c.method === "POST" && c.url.includes("/issues/1/comments"));

/** The App is installed on the mapped org; membership answers default
 *  to 404 (GitHub's documented "not a member") unless a test overrides. */
const armMembership = () => {
  fx.routes.set("/orgs/example-org/installation", () => Response.json({ id: 42 }, { status: 200 }));
};

const setCommitters = (...logins: Array<{ login: string; email: string } | { login: null; email: string }>) =>
  fx.routes.set(
    "/repos/rnpgp/rnp/pulls/1/commits",
    () =>
      Response.json(
        logins.map((l) => ({ author: { login: l.login, type: l.login ? "User" : null }, commit: { author: { email: l.email } } })),
        { status: 200 },
      ),
  );

// ---- the transport leg ----

describe("org membership: the transport leg", () => {
  const map = { "example-org": "mtg-ag" };

  it("resolves a member to a fact; a non-member (404) is an answer, not an error", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/member-one", () => new Response(null, { status: 204 }));
    fx.routes.set("/orgs/example-org/members/nonmember", () => new Response(null, { status: 404 }));

    const facts = await resolveOrgMemberships(makeApi(), map, ["Member-One", "nonmember"]);
    expect(facts).toEqual([{ login: "member-one", org: "example-org" }]);
  });

  it("the App not being installed on the mapped org throws with the config named", async () => {
    fx.routes.set("/orgs/example-org/installation", () => Response.json({ message: "Not Found" }, { status: 404 }));
    await expect(resolveOrgMemberships(makeApi(), map, ["someone"])).rejects.toThrow(
      /coverage\.org_membership maps the GitHub org "example-org", but the App is not installed on it/,
    );
  });

  it("a 403 (missing Members permission) fails closed with the remedy named", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/someone", () => Response.json({ message: "Resource not accessible" }, { status: 403 }));
    await expect(resolveOrgMemberships(makeApi(), map, ["someone"])).rejects.toThrow(
      /failed: 403 \(the App needs the Members: read permission on that organization\)/,
    );
  });

  it("config OFF or nothing to ask: zero GitHub calls", async () => {
    expect(await resolveOrgMemberships(makeApi(), {}, ["someone"])).toEqual([]);
    expect(await resolveOrgMemberships(makeApi(), map, [])).toEqual([]);
    expect(membershipCalls()).toEqual([]);
  });
});

// ---- the two-pass rule: only the otherwise-uncovered are asked about ----

describe("org membership: only the otherwise-uncovered are asked about", () => {
  it("a covered committer costs no membership call; an uncovered one is resolved and re-evaluated", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/stranger", () => new Response(null, { status: 204 }));
    // falko-strenzke holds a live Schedule A row in the fixture data; stranger holds nothing.
    const snapshot = (await loadFixtureSnapshot()).snapshot;
    const cfg = configWithMembership();
    const editions = kernelEditions(cfg);
    const run = () =>
      evaluate(
        { context: { org: "rnpgp", repo: "rnp", pr: 1 }, committers: [{ login: "falko-strenzke" }, { login: "stranger" }] },
        snapshot,
        cfg,
        editions,
      );

    const verdict = await evaluateWithOrgMembership(makeApi(), cfg, snapshot, run);
    expect(verdict.committers.find((c) => c.login === "falko-strenzke")).toMatchObject({ status: "covered", path: "ocla" });
    expect(verdict.committers.find((c) => c.login === "stranger")).toMatchObject({
      status: "covered",
      path: "ocla",
      viaOrgMembership: true,
    });
    // exactly one membership QUESTION, for the uncovered login only
    // (the installation lookup happens once per mapped org, not per committer)
    expect(membershipCalls().filter((c) => c.url.includes("/members/")).map((c) => c.url)).toEqual([
      "https://api.github.com/orgs/example-org/members/stranger",
    ]);
  });

  it("config OFF: an uncovered committer is evaluated in one pass with no GitHub membership calls", async () => {
    const snapshot = (await loadFixtureSnapshot()).snapshot;
    const cfg = GENERATED_CONFIG;
    const editions = kernelEditions(cfg);
    const verdict = await evaluateWithOrgMembership(makeApi(), cfg, snapshot, () =>
      evaluate({ context: { org: "rnpgp", repo: "rnp", pr: 1 }, committers: [{ login: "stranger" }] }, snapshot, cfg, editions),
    );
    expect(verdict.committers[0]?.status).toBe("missing");
    expect(membershipCalls()).toEqual([]);
  });
});

// ---- the enforcement surfaces ----

describe("org membership: the enforcement surfaces", () => {
  it("the check goes green with the designation disclosed, and the thread stays silent", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/stranger", () => new Response(null, { status: 204 }));
    setCommitters({ login: "stranger", email: "s@x.example" });

    const r = await evaluatePullRequest({ api: makeApi(), config: configWithMembership() }, {
      installationId: 42,
      repoFullName: "rnpgp/rnp",
      prNumber: 1,
      headSha: "abc123",
    });

    expect(r.handled).toBe(true);
    expect(checkRun()!.body).toMatchObject({ conclusion: "success" });
    expect((checkRun()!.body as Record<string, unknown>)["output"]).toMatchObject({
      summary: expect.stringContaining("covered via **ocla** (mtg-ag OCLA — designated by GitHub org membership)"),
    });
    // silence when covered: no conversation comment is posted
    expect(commentsPosted()).toEqual([]);
  });

  it("a non-member is asked to sign exactly as before", async () => {
    armMembership();
    setCommitters({ login: "stranger", email: "s@x.example" });

    await evaluatePullRequest({ api: makeApi(), config: configWithMembership() }, {
      installationId: 42,
      repoFullName: "rnpgp/rnp",
      prNumber: 1,
      headSha: "abc123",
    });

    expect(checkRun()!.body).toMatchObject({ conclusion: "failure" });
    expect(commentsPosted()).toHaveLength(1);
    const text = (commentsPosted()[0]!.body as Record<string, unknown>)["body"] as string;
    expect(text).toContain("@stranger");
    expect(text).toContain("[Sign the Individual CLA](");
    // membership was consulted (the App is installed, the answer is 404)
    // and it changed nothing: a non-member is a non-member.
    expect(membershipCalls().filter((c) => c.url.includes("/members/"))).toHaveLength(1);
  });

  it("an unverifiable membership fails closed: the evaluation throws, no check is posted", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/stranger", () => Response.json({ message: "boom" }, { status: 500 }));
    setCommitters({ login: "stranger", email: "s@x.example" });

    await expect(
      evaluatePullRequest({ api: makeApi(), config: configWithMembership() }, {
        installationId: 42,
        repoFullName: "rnpgp/rnp",
        prNumber: 1,
        headSha: "abc123",
      }),
    ).rejects.toThrow(/membership check example-org\/stranger failed: 500/);
    // fail-closed: no conclusion was written, so nothing can read as a pass
    expect(checkRun()).toBeUndefined();
  });

  it("the closing attribution never says 'merged without coverage' about a designated member", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/stranger", () => new Response(null, { status: 204 }));
    // One designated member, one genuinely uncovered committer: the gap
    // keeps the closing statement posted, so both renderings are visible.
    setCommitters({ login: "stranger", email: "s@x.example" }, { login: "tj-91", email: "johannes@mtg.example" });
    fx.routes.set("/repos/rnpgp/rnp/pulls/1/commits", () =>
      Response.json(
        [
          { author: { login: "stranger", type: "User" }, commit: { author: { email: "s@x.example" } } },
          { author: { login: "newdev", type: "User" }, commit: { author: { email: "n@x.example" } } },
        ],
        { status: 200 },
      ),
    );

    const r = await closeMergedPullRequest({ api: makeApi(), config: configWithMembership() }, {
      installationId: 42,
      repoFullName: "rnpgp/rnp",
      prNumber: 1,
    });
    expect(r.posted).toBe(true);
    const closing = commentsPosted().at(-1)!;
    const text = (closing.body as Record<string, unknown>)["body"] as string;
    expect(text).toContain("- @stranger — contributed under **the mtg-ag OCLA v");
    expect(text).toContain("(designated by GitHub org membership)");
    expect(text).toContain("- @newdev — **merged without CLA coverage**");
    expect(text).not.toContain("- @stranger — **merged without CLA coverage**");
  });

  it("`agree company=` for a designated member answers already-covered; no join request is filed", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/stranger", () => new Response(null, { status: 204 }));
    setCommitters({ login: "stranger", email: "s@x.example" });
    let joinFiled = false;

    const r = await handleAgreeCommand(
      { api: makeApi(), config: configWithMembership(), requestJoin: async () => ((joinFiled = true), { requested: true }) },
      { installationId: 42, repoFullName: "rnpgp/rnp", prNumber: 1, commenter: "stranger", prAuthor: "stranger", command: { kind: "company", company: "mtg-ag" } },
    );

    expect(r.replied).toBe(true);
    expect(r.reason).toBe("already covered");
    expect(joinFiled).toBe(false);
    const reply = commentsPosted().at(-1)!;
    expect((reply.body as Record<string, unknown>)["body"] as string).toContain("already covered on this pull request (ocla)");
  });

  it("`status` names the designation instead of 'no live agreement'", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/stranger", () => new Response(null, { status: 204 }));
    setCommitters({ login: "stranger", email: "s@x.example" });

    const r = await handleMetaCommand(
      { api: makeApi(), config: configWithMembership() },
      { installationId: 42, repoFullName: "rnpgp/rnp", prNumber: 1, commenter: "stranger", prAuthor: "stranger", command: "status" },
    );

    expect(r.reason).toBe("status: org-membership");
    const reply = commentsPosted().at(-1)!;
    const text = (reply.body as Record<string, unknown>)["body"] as string;
    expect(text).toContain("covered through the **mtg-ag Organization CLA**, designated by your GitHub org membership");
  });

  it("`status` with config OFF never asks GitHub and reports no agreement", async () => {
    setCommitters({ login: "stranger", email: "s@x.example" });

    const r = await handleMetaCommand(
      { api: makeApi(), config: GENERATED_CONFIG },
      { installationId: 42, repoFullName: "rnpgp/rnp", prNumber: 1, commenter: "stranger", prAuthor: "stranger", command: "status" },
    );

    expect(r.reason).toBe("status: none");
    expect(membershipCalls()).toEqual([]);
  });
});

// ---- fixture plumbing ----

async function loadFixtureSnapshot() {
  const { loadSnapshot } = await import("../src/store/load");
  const { makeListRecords } = await import("../src/store/github-store");
  const cfg = configWithMembership();
  return loadSnapshot({ listRecords: makeListRecords(makeApi(), cfg.github.dataInstallationId, cfg.github.dataRepo) }, kernelEditions(cfg));
}

// ---- the operator report ----

describe("org membership: the coverage report tells the operator the same truth", () => {
  it("an outstanding login that is a designated member reads as signed, via_org_membership", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/stranger", () => new Response(null, { status: 204 }));
    fx.routes.set("/installation/repositories", () =>
      Response.json({ total_count: 1, repositories: [{ full_name: "rnpgp/rnp" }] }, { status: 200 }),
    );
    fx.routes.set("/repos/rnpgp/rnp/license", () => Response.json({}, { status: 404 }));
    fx.routes.set("/repos/rnpgp/rnp/commits", () =>
      Response.json([{ author: { login: "stranger", type: "User" }, commit: { author: { email: "s@x.example" } } }], { status: 200 }),
    );

    const { repoCoverageStep } = await import("../src/enforcement/report");
    const out = await repoCoverageStep({ api: makeApi(), config: configWithMembership() }, 42);

    expect(out.repos[0]!.contributors[0]).toMatchObject({
      login: "stranger",
      state: "signed",
      path: "ocla",
      org_slug: "mtg-ag",
      via_org_membership: true,
    });
    // the login was asked about exactly once across the step
    expect(membershipCalls().filter((c) => c.url.includes("/members/"))).toHaveLength(1);
  });

  it("config OFF: the report makes no membership calls", async () => {
    fx.routes.set("/installation/repositories", () =>
      Response.json({ total_count: 1, repositories: [{ full_name: "rnpgp/rnp" }] }, { status: 200 }),
    );
    fx.routes.set("/repos/rnpgp/rnp/license", () => Response.json({}, { status: 404 }));
    fx.routes.set("/repos/rnpgp/rnp/commits", () =>
      Response.json([{ author: { login: "stranger", type: "User" }, commit: { author: { email: "s@x.example" } } }], { status: 200 }),
    );

    const { repoCoverageStep } = await import("../src/enforcement/report");
    const out = await repoCoverageStep({ api: makeApi(), config: GENERATED_CONFIG }, 42);

    expect(out.repos[0]!.contributors[0]).toMatchObject({ login: "stranger", state: "outstanding" });
    expect(membershipCalls()).toEqual([]);
  });
});

// ---- honest reasons: a stale mapped OCLA tells the member why ----

describe("org membership: the stale-edition hint (the #123 honesty, for members)", () => {
  it("a designated member whose mapped OCLA went stale reads WHY, not just 'sign the ICLA'", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/stranger", () => new Response(null, { status: 204 }));
    // The mapped OCLA exists ONLY against a superseded edition: the
    // membership fact is real, but nothing live designates under.
    fx.routes.set("/repos/example-org/cla-data/git/trees/HEAD", () =>
      Response.json({ tree: [{ path: "ocla/2025/01/mtg-old.json", type: "blob" }] }, { status: 200 }),
    );
    fx.routes.set("/repos/example-org/cla-data/contents/ocla/2025/01/mtg-old.json", () =>
      Response.json(
        {
          content: Buffer.from(
            JSON.stringify({ ...DATA_OCLA(), claEdition: { kind: "ocla", version: "0.9", textSha256: "oldoclasha" } }),
          ).toString("base64"),
          encoding: "base64",
        },
        { status: 200 },
      ),
    );
    setCommitters({ login: "stranger", email: "s@x.example" });

    await evaluatePullRequest({ api: makeApi(), config: configWithMembership() }, {
      installationId: 42,
      repoFullName: "rnpgp/rnp",
      prNumber: 1,
      headSha: "abc123",
    });

    expect(checkRun()!.body).toMatchObject({ conclusion: "failure" });
    const text = (commentsPosted()[0]!.body as Record<string, unknown>)["body"] as string;
    // the reason, the edition, and the real remedy — not a bare "sign the ICLA"
    expect(text).toContain("Your coverage under mtg-ag's Organization CLA comes from your GitHub org membership");
    expect(text).toContain("superseded by v1.0");
    expect(text).toContain("the organization's signatory must re-execute it");
  });
});

describe("org membership: the report asks each login once per step", () => {
  it("the same outstanding login across two repositories costs one membership question", async () => {
    armMembership();
    fx.routes.set("/orgs/example-org/members/stranger", () => new Response(null, { status: 204 }));
    fx.routes.set("/installation/repositories", () =>
      Response.json({ total_count: 2, repositories: [{ full_name: "rnpgp/rnp" }, { full_name: "rnpgp/rnp2" }] }, { status: 200 }),
    );
    for (const repo of ["rnpgp/rnp", "rnpgp/rnp2"]) {
      fx.routes.set(`/repos/${repo}/license`, () => Response.json({}, { status: 404 }));
      fx.routes.set(`/repos/${repo}/commits`, () =>
        Response.json([{ author: { login: "stranger", type: "User" }, commit: { author: { email: "s@x.example" } } }], { status: 200 }),
      );
    }

    const { repoCoverageStep } = await import("../src/enforcement/report");
    const out = await repoCoverageStep({ api: makeApi(), config: configWithMembership() }, 42);

    expect(out.repos).toHaveLength(2);
    for (const row of out.repos) expect(row.contributors[0]).toMatchObject({ state: "signed", via_org_membership: true });
    expect(membershipCalls().filter((c) => c.url.includes("/members/"))).toHaveLength(1);
  });
});
