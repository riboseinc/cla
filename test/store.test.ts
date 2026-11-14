import { describe, expect, it } from "vitest";
import { foldScheduleA, parseIcla, parseOcla, parseOclaMod, parseRevocation } from "../src/store/records";
import { loadSnapshot, loadAndEvaluate } from "../src/store/load";
import { sha256Hex, verifyEvidence } from "../src/store/evidence";
import type { Editions, Committer, Config, PrInput } from "@riboseinc/cla-kernel";

const EDITIONS: Editions = {
  icla: { kind: "icla", version: "1.0", textSha256: "icla1sha" },
  ocla: { kind: "ocla", version: "1.0", textSha256: "ocla1sha" },
};

const CFG: Config = { coverage: { allowlist: { global: [], perOrg: {} } } };

describe("records: parsing fails closed", () => {
  it("an icla missing required fields is rejected", () => {
    expect(parseIcla({ id: "x" })).toBeUndefined();
    expect(parseIcla({ id: "x", githubLogin: "a", claEdition: { kind: "icla", version: "1.0", textSha256: "s" } })).toBeDefined();
  });

  it("an ocla with unparseable covered rows keeps only valid rows; no id/edition rejected", () => {
    const bad = parseOcla({ id: "o", orgSlug: "s", covered: [{ nope: 1 }, { githubLogin: "ok" }], claEdition: { kind: "ocla", version: "1.0", textSha256: "s" } });
    expect(bad?.covered).toEqual([{ githubLogin: "ok", email: null }]);
    expect(parseOcla({ orgSlug: "s" })).toBeUndefined();
  });

  it("an ocla-mod without oclaId is rejected", () => {
    expect(parseOclaMod({ id: "m", recordedAt: "2026-11-12" })).toBeUndefined();
  });

  it("a revocation parses its target id in either shape", () => {
    expect(parseRevocation({ target: { id: "ocla-1" } })).toBe("ocla-1");
    expect(parseRevocation({ targetId: "icla-9" })).toBe("icla-9");
    expect(parseRevocation({})).toBeUndefined();
  });
});

describe("records: Schedule-A folding", () => {
  const rows = [
    { githubLogin: "tj-91", email: null },
    { githubLogin: "falko-strenzke", email: null },
  ];

  it("removal is case-insensitive and re-add after removal restores coverage", () => {
    const after = foldScheduleA(rows, [{ id: "m1", oclaId: "o", removeLogins: ["TJ-91"], recordedAt: "2026-11-12T00:00:00Z" }]);
    expect(after.map((r) => r.githubLogin)).toEqual(["falko-strenzke"]);
    const back = foldScheduleA(after, [{ id: "m2", oclaId: "o", add: [{ githubLogin: "tj-91", email: "new@mtg.example" }], recordedAt: "2026-11-13T00:00:00Z" }]);
    expect(back).toHaveLength(2);
    expect(back.find((r) => r.githubLogin === "tj-91")?.email).toBe("new@mtg.example");
  });

  it("mods apply in the given order", () => {
    const out = foldScheduleA([], [
      { id: "m1", oclaId: "o", add: [{ githubLogin: "a", email: null }], recordedAt: "" },
      { id: "m2", oclaId: "o", removeLogins: ["a"], recordedAt: "" },
    ]);
    expect(out).toEqual([]);
  });
});

describe("loadSnapshot: the record tree becomes a kernel snapshot", () => {
  const fixture = (files: Record<string, unknown>) => ({
    listRecords: async () => ({
      paths: Object.keys(files).sort(),
      read: async (p: string) => JSON.stringify(files[p]),
    }),
  });

  it("MTG-style backfill: ocla covers Schedule A through the kernel end-to-end", async () => {
    const files = {
      "ocla/2026/03/mtg-ag.json": {
        id: "ocla-mtg",
        orgSlug: "mtg-ag",
        claEdition: { kind: "ocla", version: "1.0", textSha256: "ocla1sha" },
        covered: [{ githubLogin: "TJ-91" }, { githubLogin: "falko-strenzke" }],
        signatory: { name: "Signatory", email: "s@mtg.example" },
        poc: { name: "PoC", email: "p@mtg.example" },
        domains: ["mtg.example", "mgt.example"],
        pastContributionsIncluded: true,
        source: "backfill",
      },
    };
    const fx = fixture(files);
    const v = await loadAndEvaluate(
      fx,
      EDITIONS,
      { context: { org: "rnpgp", repo: "rnp" }, committers: [{ login: "tj-91" }, { login: "falko-strenzke" }] } as PrInput,
      CFG,
    );
    expect(v.verdict.verdict).toBe("pass");
    expect(v.verdict.committers[0]).toMatchObject({ status: "covered", path: "ocla" });
    expect(v.verdict.committers[1]).toMatchObject({ status: "covered", path: "ocla" });
    expect(v.loaded.rejected).toEqual([]);
  });

  it("mods fold into effective Schedule A: a removed member reads missing", async () => {
    const files = {
      "ocla/2026/03/o.json": {
        id: "o1", orgSlug: "x", claEdition: { kind: "ocla", version: "1.0", textSha256: "ocla1sha" },
        covered: [{ githubLogin: "a" }, { githubLogin: "b" }],
      },
      "ocla-mod/2026/11/m.json": { id: "m1", oclaId: "o1", removeLogins: ["b"], recordedAt: "2026-11-12T00:00:00Z" },
    };
    const { snapshot } = await loadSnapshot(fixture(files), EDITIONS);
    expect(snapshot.oclas[0]?.covered.map((r) => r.githubLogin)).toEqual(["a"]);

    const committer: Committer = { login: "b" };
    const v = await loadAndEvaluate(fixture(files), EDITIONS, { context: { org: "o", repo: "r", pr: 1 }, committers: [committer] }, CFG);
    expect(v.verdict.committers[0]?.status).toBe("missing");
  });

  it("revocations remove an icla and a whole ocla; invalid records are rejected visibly", async () => {
    const files = {
      "icla/2026/11/i.json": { id: "i1", githubLogin: "solo", claEdition: { kind: "icla", version: "1.0", textSha256: "icla1sha" } },
      "ocla/2026/03/o.json": { id: "o1", orgSlug: "x", claEdition: { kind: "ocla", version: "1.0", textSha256: "ocla1sha" }, covered: [{ githubLogin: "b" }] },
      "revocation/2026/11/r1.json": { target: { id: "o1" }, reason: "void" },
      "icla/2026/11/broken.json": { githubLogin: "no-id" },
    };
    const { snapshot, rejected } = await loadSnapshot(fixture(files), EDITIONS);
    expect(snapshot.iclas.map((r) => r.id)).toEqual(["i1"]);
    expect(snapshot.oclas).toEqual([]);
    expect(rejected.map((r) => r.path)).toEqual(["icla/2026/11/broken.json"]);
  });

  it("stale-edition records survive loading but read missing to the kernel", async () => {
    const files = {
      "icla/2026/09/old.json": { id: "old", githubLogin: "a", claEdition: { kind: "icla", version: "0.9", textSha256: "oldsha" } },
    };
    const v = await loadAndEvaluate(fixture(files), EDITIONS, { context: { org: "o", repo: "r", pr: 1 }, committers: [{ login: "a" }] }, CFG);
    expect(v.verdict.committers[0]?.status).toBe("missing");
  });
});

describe("evidence: fail-closed verification", () => {
  const content = "scan-bytes";

  const sha = (): Promise<string> => sha256Hex(content);

  it("matching hash verifies", async () => {
    expect(await verifyEvidence({ readOffline: async () => content }, { repo: "r", path: "p.pdf", sha256: await sha() })).toEqual({ valid: true });
  });

  it("mismatched hash fails with the reason", async () => {
    const v = await verifyEvidence({ readOffline: async () => "tampered" }, { repo: "r", path: "p.pdf", sha256: await sha() });
    expect(v).toMatchObject({ valid: false });
  });

  it("missing file and incomplete pointer fail", async () => {
    expect(await verifyEvidence({ readOffline: async () => undefined }, { repo: "r", path: "gone.pdf", sha256: await sha() })).toMatchObject({ valid: false });
    expect(await verifyEvidence({ readOffline: async () => content }, { repo: "r", path: "", sha256: await sha() })).toMatchObject({ valid: false });
  });
});
