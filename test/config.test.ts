import { describe, expect, it } from "vitest";
import { parseConfig, currentEditions, editionText } from "../src/config";

const VALID = `
instance:
  name: Example
  portal_host: cla.example.org
identity:
  issuer: https://id.example.org
  client_id: cid
  service_token_ref: SERVICE_TOKEN
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
  notify: { digest_threshold: 7, from: notify.example.org }
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

});

describe("sha helper sanity", () => {
  it("the sync node hash equals the async WebCrypto digest", async () => {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x"));
    const web = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(web).toBe(shaSync("x"));
  });
});
