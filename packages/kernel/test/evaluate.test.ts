import { describe, expect, it } from "vitest";
import {
  evaluate,
  type Committer,
  type Config,
  type Editions,
  type PrInput,
  type StoreSnapshot,
} from "../src/evaluate";

// ---- fixture helpers (plain data — the real input types, no doubles) ----

const EDITIONS: Editions = {
  icla: { kind: "icla", version: "1.0", textSha256: "icla1sha" },
  ocla: { kind: "ocla", version: "1.0", textSha256: "ocla1sha" },
};

const config = (over: Partial<Config["coverage"]> = {}): Config => ({
  coverage: {
    allowlist: { global: [], perOrg: {}, ...over.allowlist },
  },
});

const icla = (over: Partial<StoreSnapshot["iclas"][number]> = {}): StoreSnapshot["iclas"][number] => ({
  id: "icla-1",
  githubLogin: "contributor-a",
  email: "a@example.com",
  edition: EDITIONS.icla,
  ...over,
});

const ocla = (over: Partial<StoreSnapshot["oclas"][number]> = {}): StoreSnapshot["oclas"][number] => ({
  id: "ocla-1",
  orgSlug: "mtg-ag",
  covered: [
    { githubLogin: "tj-91", email: "johannes@mtg.example" },
    { githubLogin: "falko-strenzke", email: "falko@mtg.example" },
  ],
  edition: EDITIONS.ocla,
  ...over,
});

const snapshot = (over: Partial<StoreSnapshot> = {}): StoreSnapshot => ({
  iclas: [],
  oclas: [],
  revokedIds: [],
  ...over,
});

const pr = (committers: Committer[], org = "rnpgp"): PrInput => ({
  context: { org, repo: "rnp", pr: 1 },
  committers,
});

const login = (l: string, email?: string): Committer => ({ login: l, email });

// ---- the coverage matrix ----

describe("kernel: allowlist", () => {
  it("global allowlist covers a bot login, short-circuiting any agreements", () => {
    const snap = snapshot({ iclas: [icla({ githubLogin: "dependabot[bot]" })] });
    const v = evaluate(
      pr([login("dependabot[bot]")]),
      snap,
      config({ allowlist: { global: ["dependabot[bot]"], perOrg: {} } }),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "allowlist" });
    expect(v.verdict).toBe("pass");
  });

  it("per-org allowlist applies only to the matching org", () => {
    const v = evaluate(
      pr([login("conormis-ci")], "conormis"),
      snapshot(),
      config({ allowlist: { global: [], perOrg: { conormis: ["conormis-ci"] } } }),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "allowlist" });

    const other = evaluate(
      pr([login("conormis-ci")], "rnpgp"),
      snapshot(),
      config({ allowlist: { global: [], perOrg: { conormis: ["conormis-ci"] } } }),
      EDITIONS,
    );
    expect(other.committers[0]?.status).toBe("missing");
  });
});

describe("kernel: ICLA", () => {
  it("current-edition ICLA covers its login case-insensitively", () => {
    const v = evaluate(pr([login("TJ-91")]), snapshot({ iclas: [icla({ githubLogin: "tj-91" })] }), config(), EDITIONS);
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "icla" });
  });

  it("stale-edition ICLA does not cover (re-sign required)", () => {
    const stale = icla({ edition: { kind: "icla", version: "0.9", textSha256: "oldsha" } });
    const v = evaluate(pr([login("tj-91")]), snapshot({ iclas: [stale] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("a revoked ICLA does not cover", () => {
    const v = evaluate(pr([login("tj-91")]), snapshot({ iclas: [icla()], revokedIds: ["icla-1"] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });
});

describe("kernel: OCLA Schedule A", () => {
  it("a current-edition OCLA covers its Schedule A logins", () => {
    const v = evaluate(pr([login("falko-strenzke")]), snapshot({ oclas: [ocla()] }), config(), EDITIONS);
    expect(v.committers[0]).toMatchObject({
      status: "covered",
      path: "ocla",
      agreement: { kind: "ocla", orgSlug: "mtg-ag", oclaId: "ocla-1" },
    });
  });

  it("a stale-edition OCLA does not cover its Schedule A", () => {
    const stale = ocla({ edition: { kind: "ocla", version: "0.9", textSha256: "oldsha" } });
    const v = evaluate(pr([login("tj-91")]), snapshot({ oclas: [stale] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("a voided (revoked) OCLA does not cover its Schedule A", () => {
    const v = evaluate(pr([login("tj-91")]), snapshot({ oclas: [ocla()], revokedIds: ["ocla-1"] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("a login not on Schedule A is not covered by the org's OCLA", () => {
    const v = evaluate(pr([login("stranger")]), snapshot({ oclas: [ocla()] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });
});

describe("kernel: the signature is the coverage (owner decision 2026-11-14)", () => {
  it("employment alone covers nobody — even a staff-role match must point at a signature", () => {
    // The staff/employment path was removed: every human signature is
    // clicked. No staffMap input exists anymore, so nothing can cover
    // but an ICLA record or an OCLA roster row.
    const v = evaluate(pr([login("ronald-t")]), snapshot(), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });
});

describe("kernel: must-specify (multi-agreement ambiguity)", () => {
  it("ICLA + OCLA coverage forces the PR to specify, listing both", () => {
    const snap = snapshot({ iclas: [icla({ githubLogin: "tj-91" })], oclas: [ocla()] });
    const v = evaluate(pr([login("tj-91")]), snap, config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("must-specify");
    expect(v.committers[0]?.status === "must-specify" ? v.committers[0].options : []).toEqual([
      { kind: "icla", version: "1.0" },
      { kind: "ocla", version: "1.0", oclaId: "ocla-1", orgSlug: "mtg-ag" },
    ]);
  });


  it("two OCLAs covering the same login force specification between them", () => {
    const second = ocla({ id: "ocla-2", orgSlug: "otherco" });
    const v = evaluate(pr([login("tj-91")]), snapshot({ oclas: [ocla(), second] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("must-specify");
  });
});

describe("kernel: unlinked-email fallback", () => {
  it("a commit with no GitHub login matches an ICLA by email", () => {
    const v = evaluate(
      pr([{ login: null, email: "A@Example.com" }]),
      snapshot({ iclas: [icla({ email: "a@example.com" })] }),
      config(),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "icla", matchedBy: "email" });
  });

  it("a login that misses but an email that hits still covers", () => {
    const v = evaluate(
      pr([login("someone-else", "falko@mtg.example")]),
      snapshot({ oclas: [ocla()] }),
      config(),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "ocla", matchedBy: "email" });
  });

  it("no login and no email match => missing", () => {
    const v = evaluate(pr([{ login: null, email: "unknown@example.com" }]), snapshot(), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });
});

describe("kernel: attribution elections resolve must-specify", () => {
  const both = () => snapshot({ iclas: [icla({ githubLogin: "tj-91" })], oclas: [ocla()] });

  it("a stored election for this (repo, pr, login) resolves to covered", () => {
    const snap = both();
    snap.attributions = [{ repo: "rnpgp/rnp", pr: 1, login: "tj-91", agreement: { kind: "ocla", version: "1.0", oclaId: "ocla-1", orgSlug: "mtg-ag" } }];
    const v = evaluate(pr([login("tj-91")]), snap, config(), EDITIONS);
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "ocla" });
    expect(v.mustSpecify["tj-91"]).toBeUndefined();
  });

  it("an election for another login or PR does not resolve", () => {
    const snap = both();
    snap.attributions = [{ repo: "rnpgp/rnp", pr: 2, login: "tj-91", agreement: { kind: "icla", version: "1.0" } }];
    expect(evaluate(pr([login("tj-91")]), snap, config(), EDITIONS).committers[0]?.status).toBe("must-specify");
  });

  it("an election naming a no-longer-live agreement stays must-specify", () => {
    const snap = both();
    snap.attributions = [{ repo: "rnpgp/rnp", pr: 1, login: "tj-91", agreement: { kind: "icla", version: "1.0" } }];
    // remove the icla path: only the ocla remains -> single path anyway... instead void the ocla and elect ocla
    snap.oclas = [];
    snap.attributions = [{ repo: "rnpgp/rnp", pr: 1, login: "tj-91", agreement: { kind: "ocla", version: "1.0", oclaId: "ocla-1", orgSlug: "mtg-ag" } }];
    const v = evaluate(pr([login("tj-91")]), snap, config(), EDITIONS);
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "icla" }); // single live path wins, not the dead election
  });
});

describe("kernel: bots and PR verdicts", () => {
  it("bot committers are excluded from the verdict entirely", () => {
    const v = evaluate(
      pr([login("tj-91"), { login: "dependabot[bot]", isBot: true }]),
      snapshot({ oclas: [ocla()] }),
      config(),
      EDITIONS,
    );
    expect(v.committers).toHaveLength(1);
    expect(v.verdict).toBe("pass");
  });

  it("PR verdict fails when any committer is missing", () => {
    const v = evaluate(
      pr([login("tj-91"), login("stranger")]),
      snapshot({ oclas: [ocla()] }),
      config(),
      EDITIONS,
    );
    expect(v.verdict).toBe("fail");
    expect(v.missing).toEqual(["stranger"]);
  });

  it("PR verdict surfaces must-specify without failing the covered", () => {
    const snap = snapshot({ iclas: [icla({ githubLogin: "tj-91" })], oclas: [ocla()] });
    const v = evaluate(pr([login("tj-91"), login("falko-strenzke")]), snap, config(), EDITIONS);
    expect(v.verdict).toBe("pass");
    expect(v.mustSpecify["tj-91"]).toBeDefined();
    expect(v.mustSpecify["falko-strenzke"]).toBeUndefined();
  });

  it("committers keep their input order (deterministic output)", () => {
    const v = evaluate(
      pr([login("zeta"), login("alpha")]),
      snapshot({ iclas: [icla({ githubLogin: "zeta" }), icla({ id: "icla-2", githubLogin: "alpha" })] }),
      config(),
      EDITIONS,
    );
    expect(v.committers.map((c) => c.login)).toEqual(["zeta", "alpha"]);
  });
});
