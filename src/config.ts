import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import { isSpdxId } from "./spdx";

/**
 * The instance config: parsed, validated, FAIL-CLOSED at gen time
 * (docs/design.md §7). Instance data is never compiled-in by hand —
 * `scripts/gen.ts` compiles the instance repo's YAML + legal texts
 * into src/generated/config.ts; this module owns the shape and the
 * validation. Adding an org, exempting a bot, or flipping an edition
 * is a config edit + deploy, never an engine change.
 */

export type EditionFile = { version: string; file: string; text: string; sha256: string };

export type AppConfig = {
  instance: { name: string; portalHost: string; signingDocsUrl?: string; rosterManagers?: string[]; separateAgreement?: { logins: string[]; emails: string[] } };
  roster?: { members: Array<{ login: string; role: string; name: string }> };
  identity: { issuer: string; clientId: string };
  legal: {
    editions: { icla: EditionFile[]; ocla: EditionFile[] };
    current: { icla: string; ocla: string }; // version strings
    /** Counsel-owned accepted-license list for clause-7 third-party
     *  declarations (issue #118). `undefined` is UNCONFIGURED; an empty
     *  list is an explicit "nothing is accepted". Both refuse: a
     *  third-party declaration never rides in unchecked. */
    thirdParty?: { acceptedLicenses: string[] };
  };
  github: {
    appSlug: string;
    dataRepo: string; // "org/name"
    offlineRepo: string; // "org/name"
    dataInstallationId: number;
  };
  coverage: {
    allowlist: { global: string[]; perOrg: Record<string, string[]> };
    minimalChange?: { files: number; codeLines: number };
    /** Coverage by GitHub-org membership (issue #16 item 4): a GitHub
     *  org login -> the OCLA slug it designates under. Absent = OFF. */
    orgMembership?: Record<string, string>;
    reposWithoutCla: string[]; // "org/name"
    commentSigning: { automatic: boolean };
    notify: { digestThreshold: number; from: string };
  };
};

export type LegalReader = (pathRelativeToConfig: string) => Promise<string>;

export type ConfigParseError = { path: string; message: string };
export type ConfigParseResult = { config: AppConfig } | { errors: ConfigParseError[] };

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const lowerAll = (xs: unknown): string[] => arr(xs).flatMap((x) => (str(x) ? [str(x)!.toLowerCase()] : []));

/** "org/name" shape — the only repo reference format the config accepts. */
const isRepoRef = (s: string): boolean => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);

/** A bare addr-spec, or a display name followed by one in angle brackets. */
const isMailbox = (s: string): boolean => {
  const addr = "[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+";
  return new RegExp(`^${addr}$`).test(s) || new RegExp(`^.+<${addr}>$`).test(s);
};

async function parseEditions(
  raw: unknown,
  kind: "icla" | "ocla",
  readLegal: LegalReader,
  errors: ConfigParseError[],
): Promise<{ files: EditionFile[]; current?: string }> {
  const node = obj(raw);
  const current = str(node["current"]);
  const filesRaw = obj(node["files"]);
  const files: EditionFile[] = [];
  const versions = new Set<string>();
  for (const [version, file] of Object.entries(filesRaw)) {
    const f = str(file);
    if (!f) {
      errors.push({ path: `legal.editions.${kind}.files.${version}`, message: "file path missing" });
      continue;
    }
    let text: string;
    try {
      text = await readLegal(f);
    } catch (e) {
      errors.push({ path: `legal.editions.${kind}.files.${version}`, message: `legal text unreadable: ${(e as Error).message}` });
      continue;
    }
    versions.add(version);
    files.push({ version, file: f, text, sha256: sha256(text) });
  }
  if (!current || !versions.has(current)) {
    errors.push({ path: `legal.editions.${kind}.current`, message: `current version "${current ?? ""}" not present in files` });
  }
  return { files, current };
}

export async function parseConfig(yamlText: string, readLegal: LegalReader): Promise<ConfigParseResult> {
  const errors: ConfigParseError[] = [];
  let root: unknown;
  try {
    root = parseYaml(yamlText);
  } catch (e) {
    return { errors: [{ path: "(yaml)", message: `unparseable YAML: ${(e as Error).message}` }] };
  }
  const r = obj(root);

  const instance = obj(r["instance"]);
  const name = str(instance["name"]);
  const portalHost = str(instance["portal_host"]);
  if (!name) errors.push({ path: "instance.name", message: "required" });
  if (!portalHost) errors.push({ path: "instance.portal_host", message: "required" });
  const signingDocsUrl = str(instance["signing_docs_url"]);
  const rosterManagers = arr(instance["roster_managers"]).map((x) => str(x)).filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase());
  // The separate-agreement registry: STATIC config text (seeded once
  // from the census; membership changes are deliberate PRs). The
  // classification (staff/contractor) is config-documentation only —
  // the app compiles just the login set and never renders it.
  const sepRaw = obj(instance["separate_agreement"]);
  const sepLogins = [...arr(sepRaw["staff"]), ...arr(sepRaw["contractors"])]
    .map((x) => str(x))
    .filter((x): x is string => Boolean(x))
    .map((x) => x.toLowerCase());
  // Known commit emails of registry logins: UNLINKED commits (the git
  // author email does not resolve to a GitHub account) carry no login,
  // so the registry matches the email the commit actually carries.
  const sepEmails: string[] = [];
  for (const emails of Object.values(obj(sepRaw["emails"]))) {
    for (const e of arr(emails)) {
      const v = str(e);
      if (v) sepEmails.push(v.toLowerCase());
    }
  }
  const separateAgreement = sepLogins.length > 0 ? { logins: [...new Set(sepLogins)], emails: [...new Set(sepEmails)] } : undefined;
  // The internal roster census: static as well; the view adds the live state.
  const rosterRaw = obj(instance["roster"]);
  const rosterMembers = arr(rosterRaw["members"])
    .map((m) => m as Record<string, unknown>)
    .map((m) => ({ login: str(m["login"]) ?? "", role: str(m["role"]) ?? "staff", name: str(m["name"]) ?? "" }))
    .filter((m) => m.login);
  const roster = rosterMembers.length > 0 ? { members: rosterMembers } : undefined;

  const identity = obj(r["identity"]);
  const issuer = str(identity["issuer"]);
  const clientId = str(identity["client_id"]);
  if (!issuer || !issuer.startsWith("https://")) errors.push({ path: "identity.issuer", message: "must be an https URL" });
  if (!clientId) errors.push({ path: "identity.client_id", message: "required" });

  const legalRaw = obj(r["legal"]);
  const editionsRaw = obj(legalRaw["editions"]);
  const iclaEd = await parseEditions(editionsRaw["icla"], "icla", readLegal, errors);
  const oclaEd = await parseEditions(editionsRaw["ocla"], "ocla", readLegal, errors);

  // The clause-7 accepted-license list (issue #118). Absent and empty are
  // deliberately different: absent = unconfigured (refuse), empty = an
  // explicit counsel posture that nothing is accepted. Duplicates are
  // folded case-insensitively, preserving the configured spelling.
  let thirdParty: { acceptedLicenses: string[] } | undefined;
  const thirdPartyRaw = legalRaw["third_party"];
  if (thirdPartyRaw !== undefined && thirdPartyRaw !== null) {
    const list = obj(thirdPartyRaw)["accepted_licenses"];
    if (!Array.isArray(list)) {
      errors.push({ path: "legal.third_party.accepted_licenses", message: "must be a list (an empty list accepts nothing)" });
    } else {
      const ids: string[] = [];
      for (const entry of list) {
        const id = str(entry);
        if (!id) {
          errors.push({ path: "legal.third_party.accepted_licenses", message: "entries must be non-empty strings" });
        } else if (!isSpdxId(id)) {
          errors.push({ path: "legal.third_party.accepted_licenses", message: `"${id}" is not a single SPDX identifier` });
        } else {
          ids.push(id);
        }
      }
      const seen = new Set<string>();
      thirdParty = {
        acceptedLicenses: ids.filter((id) => {
          const key = id.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    }
  }

  const github = obj(r["github"]);
  const dataRepo = str(github["data_repo"]);
  const offlineRepo = str(github["offline_repo"]);
  const appSlug = str(github["app_slug"]);
  const dataInstallationId = num(github["data_installation_id"]);
  if (!appSlug) errors.push({ path: "github.app_slug", message: "required" });
  if (!dataRepo || !isRepoRef(dataRepo)) errors.push({ path: "github.data_repo", message: "must be org/name" });
  if (!offlineRepo || !isRepoRef(offlineRepo)) errors.push({ path: "github.offline_repo", message: "must be org/name" });
  if (dataInstallationId === undefined) errors.push({ path: "github.data_installation_id", message: "required numeric installation id" });

  const coverage = obj(r["coverage"]);
  const allowRaw = obj(coverage["allowlist"]);
  const perOrg: Record<string, string[]> = {};
  for (const [org, list] of Object.entries(obj(allowRaw["per_org"]))) {
    const lowered = lowerAll(list);
    if (lowered.length !== arr(list).length) {
      errors.push({ path: `coverage.allowlist.per_org.${org}`, message: "entries must be non-empty strings" });
    }
    perOrg[org] = lowered;
  }
  const rawReposWithoutCla = coverage["repos_without_cla"];
  const reposWithoutCla: string[] = [];
  if (rawReposWithoutCla !== undefined && rawReposWithoutCla !== null) {
    if (!Array.isArray(rawReposWithoutCla)) {
      errors.push({ path: "coverage.repos_without_cla", message: "must be a list of org/name strings" });
    } else {
      for (const entry of rawReposWithoutCla) {
        const v = str(entry);
        if (!v || !isRepoRef(v)) {
          errors.push({ path: "coverage.repos_without_cla", message: `entries must be org/name (got ${JSON.stringify(entry)})` });
        } else {
          reposWithoutCla.push(v.toLowerCase());
        }
      }
    }
  }
  // The proportionality control (issue #58): absent = OFF (the default).
  const minimalRaw = obj(coverage["minimal_change"]);
  const mcFiles = num(minimalRaw["files"]);
  const mcLines = num(minimalRaw["code_lines"]);
  const minimalChange = mcFiles !== undefined && mcLines !== undefined ? { files: mcFiles, codeLines: mcLines } : undefined;
  if (minimalRaw["files"] !== undefined && minimalRaw["code_lines"] !== undefined && minimalChange === undefined) {
    errors.push({ path: "coverage.minimal_change", message: "both files and code_lines must be numeric" });
  }
  const commentSigning = obj(coverage["comment_signing"]);
  // Coverage by GitHub-org membership (issue #16 item 4): a GitHub org
  // login -> the OCLA slug its members are designated under. Absent =
  // OFF (the default); an explicitly empty map is also OFF. Keys and
  // slugs normalize to lowercase (the kernel compares lowercased).
  const orgMemRaw = coverage["org_membership"];
  let orgMembership: Record<string, string> | undefined;
  if (orgMemRaw !== undefined && orgMemRaw !== null) {
    if (typeof orgMemRaw !== "object" || Array.isArray(orgMemRaw)) {
      errors.push({ path: "coverage.org_membership", message: "must be a mapping of GitHub org -> OCLA slug" });
    } else {
      const map: Record<string, string> = {};
      for (const [org, slug] of Object.entries(orgMemRaw as Record<string, unknown>)) {
        const s = str(slug);
        if (!org.trim() || !s) {
          errors.push({ path: `coverage.org_membership.${org}`, message: "entries must be a non-empty OCLA slug" });
          continue;
        }
        map[org.trim().toLowerCase()] = s.toLowerCase();
      }
      if (Object.keys(map).length > 0) orgMembership = map;
    }
  }
  const notify = obj(coverage["notify"]);
  const digestThreshold = num(notify["digest_threshold"]) ?? 10;
  const notifyFrom = str(notify["from"]);
  // The provider's `from` is a mailbox, not a domain: a bare host is
  // rejected at gen time instead of failing at the first send.
  if (notifyFrom !== undefined && !isMailbox(notifyFrom)) {
    errors.push({ path: "coverage.notify.from", message: "must be an email address (Name <addr> allowed)" });
  }

  if (errors.length > 0) return { errors };

  return {
    config: {
      instance: {
        name: name!,
        portalHost: portalHost!,
        ...(signingDocsUrl ? { signingDocsUrl } : {}),
        ...(rosterManagers.length > 0 ? { rosterManagers } : {}),
        ...(separateAgreement ? { separateAgreement } : {}),
      },
      ...(roster ? { roster } : {}),
      identity: { issuer: issuer!, clientId: clientId! },
      legal: { editions: { icla: iclaEd.files, ocla: oclaEd.files }, current: { icla: iclaEd.current!, ocla: oclaEd.current! }, ...(thirdParty ? { thirdParty } : {}) },
      github: { appSlug: appSlug!, dataRepo: dataRepo!, offlineRepo: offlineRepo!, dataInstallationId: dataInstallationId! },
      coverage: {
        allowlist: { global: lowerAll(allowRaw["global"]), perOrg },
        ...(minimalChange ? { minimalChange } : {}),
        ...(orgMembership ? { orgMembership } : {}),
        reposWithoutCla,
        commentSigning: { automatic: bool(commentSigning["automatic"]) ?? false },
        notify: { digestThreshold, from: notifyFrom ?? `no-reply@${portalHost}` },
      },
    },
  };
}

// ---- runtime accessors (used by the worker; pure) ----

export function currentEditions(config: AppConfig): { icla: { kind: "icla"; version: string; textSha256: string }; ocla: { kind: "ocla"; version: string; textSha256: string } } {
  const find = (kind: "icla" | "ocla", version: string) => {
    const f = config.legal.editions[kind].find((e) => e.version === version);
    if (!f) throw new Error(`current ${kind} edition ${version} missing from generated config`);
    return f;
  };
  const i = find("icla", config.legal.current.icla);
  const o = find("ocla", config.legal.current.ocla);
  return {
    icla: { kind: "icla", version: i.version, textSha256: i.sha256 },
    ocla: { kind: "ocla", version: o.version, textSha256: o.sha256 },
  };
}

export function editionText(config: AppConfig, kind: "icla" | "ocla", version: string): { text: string; sha256: string } | undefined {
  const f = config.legal.editions[kind].find((e) => e.version === version);
  return f ? { text: f.text, sha256: f.sha256 } : undefined;
}

/** Kernel Editions shape (docs/design.md §3.6). */
export function kernelEditions(config: AppConfig): { icla: { kind: "icla"; version: string; textSha256: string }; ocla: { kind: "ocla"; version: string; textSha256: string } } {
  return currentEditions(config);
}
