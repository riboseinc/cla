import type { ClaEdition, IclaRecord, OclaCoveredRow, OclaRecord } from "@riboseinc/cla-kernel";

/**
 * The append-only legal records of the data repo (docs/design.md §8).
 * One JSON file per record. Parsing is hand-rolled validation — a
 * record that does not parse fails closed (absent from snapshots, and
 * surfaced by the loader's rejected list).
 */

export type RecordPath = string; // e.g. "icla/2026/11/x.json"

export type OclaModRecord = {
  id: string;
  oclaId: string;
  add?: OclaCoveredRow[];
  removeLogins?: string[];
  recordedAt: string;
};

export type AttributionRecord = {
  id: string;
  repo: string;
  pr: number;
  login: string;
  agreement: { kind: "icla" | "ocla" | "staff"; version?: string; oclaId?: string; orgSlug?: string; org?: string; role?: string };
  recordedAt: string;
};

export type Evidence = { repo: string; path: string; sha256: string };

export type IclaFile = IclaRecord & { pastContributionsIncluded: boolean; source: string; evidence?: Evidence };

export type OclaFile = OclaRecord & {
  signatory: { name: string; email: string; title?: string; githubLogin?: string | null };
  poc: { name: string; email: string; phone?: string };
  domains: string[];
  pastContributionsIncluded: boolean;
  source: string;
  evidence?: Evidence;
};

export function parseAttribution(v: unknown): AttributionRecord | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v["id"]);
  const repo = str(v["repo"]);
  const login = str(v["login"]);
  const recordedAt = str(v["recordedAt"]);
  const pr = v["pr"];
  const agreement = isObj(v["agreement"]) ? (v["agreement"] as AttributionRecord["agreement"]) : undefined;
  if (!id || !repo || !login || !recordedAt || typeof pr !== "number" || !agreement || !agreement.kind) return undefined;
  return { id, repo, pr, login, agreement, recordedAt };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function parseEdition(v: unknown): ClaEdition | undefined {
  if (!isObj(v)) return undefined;
  const kind = v["kind"];
  const version = str(v["version"]);
  const sha = str(v["textSha256"]);
  if ((kind === "icla" || kind === "ocla") && version && sha) return { kind, version, textSha256: sha };
  return undefined;
}

export function parseIcla(v: unknown): IclaFile | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v["id"]);
  const login = str(v["githubLogin"]);
  const edition = parseEdition(v["claEdition"]);
  if (!id || !login || !edition) return undefined;
  return {
    id,
    githubLogin: login,
    email: str(v["email"]) ?? null,
    edition,
    pastContributionsIncluded: v["pastContributionsIncluded"] === true,
    source: str(v["source"]) ?? "unknown",
    evidence: isObj(v["evidence"]) ? (v["evidence"] as Evidence) : undefined,
  };
}

export function parseOcla(v: unknown): OclaFile | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v["id"]);
  const slug = str(v["orgSlug"]);
  const edition = parseEdition(v["claEdition"]);
  const covered = Array.isArray(v["covered"])
    ? v["covered"].flatMap((row) => {
        if (!isObj(row)) return [];
        const l = str(row["githubLogin"]);
        return l ? [{ githubLogin: l, email: str(row["email"]) ?? null }] : [];
      })
    : [];
  if (!id || !slug || !edition) return undefined;
  return {
    id,
    orgSlug: slug,
    covered,
    edition,
    signatory: (isObj(v["signatory"]) ? v["signatory"] : {}) as OclaFile["signatory"],
    poc: (isObj(v["poc"]) ? v["poc"] : {}) as OclaFile["poc"],
    domains: Array.isArray(v["domains"]) ? v["domains"].filter((d): d is string => typeof d === "string") : [],
    pastContributionsIncluded: v["pastContributionsIncluded"] === true,
    source: str(v["source"]) ?? "unknown",
    evidence: isObj(v["evidence"]) ? (v["evidence"] as Evidence) : undefined,
  };
}

export function parseOclaMod(v: unknown): OclaModRecord | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v["id"]);
  const oclaId = str(v["oclaId"]);
  const recordedAt = str(v["recordedAt"]);
  if (!id || !oclaId || !recordedAt) return undefined;
  const add = Array.isArray(v["add"])
    ? v["add"].flatMap((row) => {
        if (!isObj(row)) return [];
        const l = str(row["githubLogin"]);
        return l ? [{ githubLogin: l, email: str(row["email"]) ?? null }] : [];
      })
    : undefined;
  const removeLogins = Array.isArray(v["removeLogins"])
    ? v["removeLogins"].filter((l): l is string => typeof l === "string")
    : undefined;
  return { id, oclaId, add, removeLogins, recordedAt };
}

/** Records killed by revocation files: `revocation/{ts}/{id}.json` → target id. */
export function parseRevocation(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const target = isObj(v["target"]) ? str(v["target"]["id"]) : undefined;
  return target ?? str(v["targetId"]);
}

/**
 * Fold Schedule-A modifications over an OCLA, in order. Order = the
 * mods array's given order (the loader passes them path-sorted, which
 * is creation order). Removals match case-insensitively; a login
 * re-added after removal is covered again (append-only history).
 */
export function foldScheduleA(original: OclaCoveredRow[], mods: OclaModRecord[]): OclaCoveredRow[] {
  const rows = [...original];
  const norm = (s: string) => s.trim().toLowerCase();
  for (const mod of mods) {
    if (mod.removeLogins) {
      const kill = new Set(mod.removeLogins.map(norm));
      let w = 0;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!;
        if (!kill.has(norm(row.githubLogin))) {
          rows[w++] = row;
        }
      }
      rows.length = w;
    }
    if (mod.add) rows.push(...mod.add);
  }
  return rows;
}
