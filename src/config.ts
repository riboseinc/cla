import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";

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
  instance: { name: string; portalHost: string };
  identity: { issuer: string; clientId: string; serviceTokenRef: string };
  legal: {
    editions: { icla: EditionFile[]; ocla: EditionFile[] };
    current: { icla: string; ocla: string }; // version strings
  };
  github: {
    appSlug: string;
    dataRepo: string; // "org/name"
    offlineRepo: string; // "org/name"
    dataInstallationId: number;
  };
  coverage: {
    staffRoles: Array<{ org: string; role: string }>;
    allowlist: { global: string[]; perOrg: Record<string, string[]> };
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

  const identity = obj(r["identity"]);
  const issuer = str(identity["issuer"]);
  const clientId = str(identity["client_id"]);
  const serviceTokenRef = str(identity["service_token_ref"]);
  if (!issuer || !issuer.startsWith("https://")) errors.push({ path: "identity.issuer", message: "must be an https URL" });
  if (!clientId) errors.push({ path: "identity.client_id", message: "required" });
  if (!serviceTokenRef) errors.push({ path: "identity.service_token_ref", message: "required" });

  const legalRaw = obj(r["legal"]);
  const editionsRaw = obj(legalRaw["editions"]);
  const iclaEd = await parseEditions(editionsRaw["icla"], "icla", readLegal, errors);
  const oclaEd = await parseEditions(editionsRaw["ocla"], "ocla", readLegal, errors);

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
  const staffRoles = arr(coverage["staff_roles"]).flatMap((x) => {
    const o = obj(x);
    const org = str(o["org"]);
    const role = str(o["role"]);
    return org && role ? [{ org, role }] : [];
  });
  if (arr(coverage["staff_roles"]).length !== staffRoles.length) {
    errors.push({ path: "coverage.staff_roles", message: "every entry needs org + role" });
  }
  const allowRaw = obj(coverage["allowlist"]);
  const perOrg: Record<string, string[]> = {};
  for (const [org, list] of Object.entries(obj(allowRaw["per_org"]))) {
    const lowered = lowerAll(list);
    if (lowered.length !== arr(list).length) {
      errors.push({ path: `coverage.allowlist.per_org.${org}`, message: "entries must be non-empty strings" });
    }
    perOrg[org] = lowered;
  }
  const reposWithoutCla = lowerAll(coverage["repos_without_cla"]).filter(isRepoRef);
  const commentSigning = obj(coverage["comment_signing"]);
  const notify = obj(coverage["notify"]);
  const digestThreshold = num(notify["digest_threshold"]) ?? 10;
  const notifyFrom = str(notify["from"]);

  if (errors.length > 0) return { errors };

  return {
    config: {
      instance: { name: name!, portalHost: portalHost! },
      identity: { issuer: issuer!, clientId: clientId!, serviceTokenRef: serviceTokenRef! },
      legal: { editions: { icla: iclaEd.files, ocla: oclaEd.files }, current: { icla: iclaEd.current!, ocla: oclaEd.current! } },
      github: { appSlug: appSlug!, dataRepo: dataRepo!, offlineRepo: offlineRepo!, dataInstallationId: dataInstallationId! },
      coverage: {
        staffRoles,
        allowlist: { global: lowerAll(allowRaw["global"]), perOrg },
        reposWithoutCla,
        commentSigning: { automatic: bool(commentSigning["automatic"]) ?? false },
        notify: { digestThreshold, from: notifyFrom ?? `${portalHost}` },
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
