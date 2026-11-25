import { describe, expect, it } from "vitest";
import { parseConfig, currentEditions, editionText } from "../src/config";

const VALID = `
instance:
  name: Example
  portal_host: cla.example.org
identity:
  issuer: https://id.example.org
  client_id: cid
legal:
  editions:
    icla: { current: "1.0", files: { "1.0": "legal/icla/1.0.md" } }
    ocla: { current: "1.0", files: { "1.0": "legal/ocla/1.0.md" } }
github:
  app_slug: example-cla
  data_repo: example-org/cla-data
  offline_repo: example-org/cla-offline
  data_installation_id: 42
coverage:
  allowlist:
    global: [ "Dependabot[bot]" ]
    per_org: { example-org: [ "Example-CI" ] }
  repos_without_cla: [ example-org/mirror ]
  comment_signing: { automatic: false }
  notify: { digest_threshold: 7, from: "Ribose CLA <cla@notify.example.org>" }
`;

const LEGAL: Record<string, string> = {
  "legal/icla/1.0.md": "ICLA v1.0 text body",
  "legal/ocla/1.0.md": "OCLA v1.0 text body",
};
const reader = async (p: string) => {
  const t = LEGAL[p];
  if (t === undefined) throw new Error(`missing: ${p}`);
  return t;
};

const { createHash } = await import("node:crypto");
const shaSync = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

describe("config: valid parse", () => {
  it("parses into the typed AppConfig with embedded edition texts + hashes", async () => {
    const r = await parseConfig(VALID, reader);
    if ("errors" in r) throw new Error(`unexpected errors: ${JSON.stringify(r.errors)}`);
    const c = r.config;

    expect(c.instance).toEqual({ name: "Example", portalHost: "cla.example.org" });
    expect(c.legal.editions.icla[0]?.text).toBe("ICLA v1.0 text body");
    expect(c.legal.editions.icla[0]?.sha256).toBe(shaSync("ICLA v1.0 text body"));
    expect(c.legal.current).toEqual({ icla: "1.0", ocla: "1.0" });
    expect(c.github.dataInstallationId).toBe(42);
    expect(c.coverage.notify.from).toBe("Ribose CLA <cla@notify.example.org>");
  });

  it("an absent notify `from` defaults to a mailbox on the portal host", async () => {
    const noNotify = VALID.replace(/  notify: \{[^\n]*\n/, "");
    const r = await parseConfig(noNotify, reader);
    if ("errors" in r) throw new Error(`unexpected errors: ${JSON.stringify(r.errors)}`);
    expect(r.config.coverage.notify.from).toBe("no-reply@cla.example.org");
  });

  it("normalizes allowlists to lowercase (the kernel compares lowercased logins)", async () => {
    const r = await parseConfig(VALID, reader);
    if ("errors" in r) throw new Error("unexpected errors");
    expect(r.config.coverage.allowlist.global).toEqual(["dependabot[bot]"]);
    expect(r.config.coverage.allowlist.perOrg["example-org"]).toEqual(["example-ci"]);
    expect(r.config.coverage.reposWithoutCla).toEqual(["example-org/mirror"]);
  });

  it("currentEditions yields the kernel shape with content hashes", async () => {
    const r = await parseConfig(VALID, reader);
    if ("errors" in r) throw new Error("unexpected errors");
    const e = currentEditions(r.config);
    expect(e.icla).toEqual({ kind: "icla", version: "1.0", textSha256: shaSync("ICLA v1.0 text body") });
    expect(e.ocla.kind).toBe("ocla");
  });

  it("editionText serves a specific version's exact text + hash (View-text contract)", async () => {
    const r = await parseConfig(VALID, reader);
    if ("errors" in r) throw new Error("unexpected errors");
    expect(editionText(r.config, "icla", "1.0")?.text).toBe("ICLA v1.0 text body");
    expect(editionText(r.config, "icla", "9.9")).toBeUndefined();
  });
});

describe("config: the clause-7 accepted-license list (issue #118)", () => {
  const withThirdParty = (block: string): string => VALID.replace("  editions:", `${block}  editions:`);

  it("parses the list, folds duplicates case-insensitively, and keeps absent distinct from empty", async () => {
    const listed = await parseConfig(withThirdParty("  third_party:\n    accepted_licenses: [ MIT, BSD-3-Clause, mit ]\n"), reader);
    if ("errors" in listed) throw new Error(`unexpected errors: ${JSON.stringify(listed.errors)}`);
    expect(listed.config.legal.thirdParty).toEqual({ acceptedLicenses: ["MIT", "BSD-3-Clause"] });

    const absent = await parseConfig(VALID, reader);
    if ("errors" in absent) throw new Error("unexpected errors");
    expect(absent.config.legal.thirdParty).toBeUndefined();

    const empty = await parseConfig(withThirdParty("  third_party:\n    accepted_licenses: []\n"), reader);
    if ("errors" in empty) throw new Error(`unexpected errors: ${JSON.stringify(empty.errors)}`);
    expect(empty.config.legal.thirdParty).toEqual({ acceptedLicenses: [] });
  });

  it("an expression or a non-string entry is a gen-time error", async () => {
    for (const bad of ['[ "MIT OR Apache-2.0" ]', "[ 3 ]"]) {
      const r = await parseConfig(withThirdParty(`  third_party:\n    accepted_licenses: ${bad}\n`), reader);
      expect("errors" in r && r.errors.some((e) => e.path === "legal.third_party.accepted_licenses")).toBe(true);
    }
  });

  it("a third_party block without accepted_licenses is an error, not an implicit empty list", async () => {
    const r = await parseConfig(withThirdParty("  third_party: {}\n"), reader);
    expect("errors" in r && r.errors.some((e) => e.path === "legal.third_party.accepted_licenses")).toBe(true);
  });
});

describe("config: fails closed at gen time", () => {
  it("current version not in files map is an error", async () => {
    const bad = VALID.replace('icla: { current: "1.0"', 'icla: { current: "2.0"');
    const r = await parseConfig(bad, reader);
    expect("errors" in r && r.errors.some((e) => e.path.includes("icla") && e.message.includes("not present"))).toBe(true);
  });

  it("unreadable legal text is an error", async () => {
    const bad = VALID.replace("legal/ocla/1.0.md", "legal/ocla/9.9.md");
    const r = await parseConfig(bad, reader);
    expect("errors" in r && r.errors.some((e) => e.message.includes("unreadable"))).toBe(true);
  });

  it("non-https issuer and malformed repo refs are errors", async () => {
    const bad = VALID.replace("https://id.example.org", "http://id.example.org").replace(
      "data_repo: example-org/cla-data",
      "data_repo: just-a-name",
    );
    const r = await parseConfig(bad, reader);
    if (!("errors" in r)) throw new Error("expected errors");
    const paths = r.errors.map((e) => e.path);
    expect(paths).toContain("identity.issuer");
    expect(paths).toContain("github.data_repo");
  });

  it("unparseable YAML is an error", async () => {
    const r = await parseConfig("instance: [oops", reader);
    expect("errors" in r).toBe(true);
  });

  it("a notify `from` that is a domain, not a mailbox, is an error", async () => {
    const bad = VALID.replace('"Ribose CLA <cla@notify.example.org>"', "notify.example.org");
    const r = await parseConfig(bad, reader);
    expect("errors" in r && r.errors.some((e) => e.path === "coverage.notify.from")).toBe(true);
  });

});

describe("sha helper sanity", () => {
  it("the sync node hash equals the async WebCrypto digest", async () => {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x"));
    const web = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(web).toBe(shaSync("x"));
  });
});

describe("config: coverage by GitHub-org membership (issue #16 item 4)", () => {
  const withOrgMembership = (block: string): string => VALID.replace("coverage:\n", `coverage:\n${block}`);

  it("parses the map with lowercased orgs and slugs", async () => {
    const r = await parseConfig(withOrgMembership("  org_membership:\n    Corp-Org: MTG-AG\n"), reader);
    if ("errors" in r) throw new Error(`unexpected errors: ${JSON.stringify(r.errors)}`);
    expect(r.config.coverage.orgMembership).toEqual({ "corp-org": "mtg-ag" });
  });

  it("absent and explicitly empty are both OFF", async () => {
    const absent = await parseConfig(VALID, reader);
    if ("errors" in absent) throw new Error("unexpected errors");
    expect(absent.config.coverage.orgMembership).toBeUndefined();

    const empty = await parseConfig(withOrgMembership("  org_membership: {}\n"), reader);
    if ("errors" in empty) throw new Error("unexpected errors");
    expect(empty.config.coverage.orgMembership).toBeUndefined();
  });

  it("fails closed: a non-map value or an empty slug is a gen-time error", async () => {
    const notAMap = await parseConfig(withOrgMembership("  org_membership: [ a ]\n"), reader);
    expect("errors" in notAMap && notAMap.errors.some((e) => e.path === "coverage.org_membership")).toBe(true);

    const emptySlug = await parseConfig(withOrgMembership("  org_membership:\n    corp-org: \"\"\n"), reader);
    expect("errors" in emptySlug && emptySlug.errors.some((e) => e.path === "coverage.org_membership.corp-org")).toBe(true);
  });
});

describe("config: repos_without_cla validation", () => {
  it("fails closed on malformed repo refs or a non-list value", async () => {
    const badEntry = VALID.replace("repos_without_cla: [ example-org/mirror ]", "repos_without_cla: [ just-a-repo ]");
    const r1 = await parseConfig(badEntry, reader);
    expect("errors" in r1 && r1.errors.some((e) => e.path === "coverage.repos_without_cla")).toBe(true);

    const notAList = VALID.replace("repos_without_cla: [ example-org/mirror ]", "repos_without_cla: example-org/mirror");
    const r2 = await parseConfig(notAList, reader);
    expect("errors" in r2 && r2.errors.some((e) => e.path === "coverage.repos_without_cla")).toBe(true);
  });
});
