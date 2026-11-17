import type { Committer, Config, Editions, StoreSnapshot } from "@riboseinc/cla-kernel";
import { evaluate } from "@riboseinc/cla-kernel";
import type { EnforcementDeps } from "./handler";
import { kernelEditions } from "../config";
import { loadSnapshot } from "../store/load";
import { makeListRecords } from "../store/github-store";

/**
 * The repo-centric coverage report (issue #88): for every installed
 * repository, its recent contributors and each one's live state —
 * signed / stale / outstanding / must-specify / allowlist / CI account,
 * with the separate-agreement registry flagged. One bounded step at a
 * time, cursor-persisting like the installation backfill, because an
 * estate is thousands of repositories and each costs a commits call.
 *
 * The App cannot read branch protection (it holds no administration
 * permission — constraint 7), so "required check armed" is NOT part of
 * this report: that answer lives in #53 and in the repository settings.
 * The report says so in `notes` rather than guessing.
 */

const PER_PAGE = 100;
export const DEFAULT_REPOS_PER_STEP = 10;
export const DEFAULT_COMMIT_WINDOW = 25;

export type CoverageCursor = { page: number; offset: number };

export type PersonState = "signed" | "stale" | "outstanding" | "must-specify" | "allowlist" | "ci-account";

export type ContributorRow = {
  login: string | null;
  email: string | null;
  state: PersonState;
  path?: "icla" | "ocla" | "separate-agreement";
  /** Which OCLA covers the person (the org slug) — set only on an
   *  `ocla` path; an ICLA row names no organization. */
  org_slug?: string;
  edition?: string;
  matched_by?: "login" | "email";
  /** The login is covered under a separate written agreement: the click
   *  still gates, only the attribution differs (never rendered publicly). */
  under_separate_agreement?: boolean;
  /** Agreement options when the person must specify which one applies. */
  options?: string[];
  last_commit?: string;
};

export type RepoCoverageRow = {
  repo: string;
  in_scope: boolean;
  note?: string;
  contributors: ContributorRow[];
};

export type RepoCoverageReport = {
  org: string | null;
  total: number;
  repos: RepoCoverageRow[];
  next: CoverageCursor | null;
  window: number;
  notes: string[];
};

const normalize = (s: string): string => s.trim().toLowerCase();

/** Any record matching this identity, regardless of liveness — the
 *  difference between "signed an old edition" and "never signed". */
function hasHistoricalRecord(
  c: Committer,
  snap: StoreSnapshot,
): { icla: boolean; ocla: boolean } {
  const login = c.login ? normalize(c.login) : null;
  const email = c.email ? normalize(c.email) : null;
  const matchesLogin = (l: string) => login !== null && normalize(l) === login;
  const matchesEmail = (e?: string | null) => email !== null && e !== null && e !== undefined && normalize(e) === email;
  return {
    icla: snap.iclas.some((r) => matchesLogin(r.githubLogin) || matchesEmail(r.email)),
    ocla: snap.oclas.some((o) => o.covered.some((row) => matchesLogin(row.githubLogin) || matchesEmail(row.email))),
  };
}

function isBotAuthor(author: Record<string, unknown> | undefined): boolean {
  if (!author) return false;
  if (author["type"] === "Bot") return true;
  const login = author["login"];
  return typeof login === "string" && login.endsWith("[bot]");
}

type CommitSample = { committers: Committer[]; lastCommit: Map<string, string> };

/** The repo's recent commits, deduped by identity, newest first (the
 *  commits endpoint returns reverse-chronological order). */
function sampleCommitters(commits: Array<Record<string, unknown>>, window: number): CommitSample {
  const byKey = new Map<string, Committer>();
  const lastCommit = new Map<string, string>();
  for (const c of commits.slice(0, window)) {
    const author = c["author"] && typeof c["author"] === "object" ? (c["author"] as Record<string, unknown>) : undefined;
    const gitAuthor = c["commit"] && typeof c["commit"] === "object" ? (c["commit"] as Record<string, unknown>)["author"] : undefined;
    const git = gitAuthor && typeof gitAuthor === "object" ? (gitAuthor as Record<string, unknown>) : {};
    const login = typeof author?.["login"] === "string" ? (author["login"] as string) : null;
    const email = typeof git["email"] === "string" ? (git["email"] as string) : null;
    if (login === null && email === null) continue;
    const key = login ?? `email:${email}`;
    if (byKey.has(key)) continue;
    const committer: Committer = { login, email, isBot: isBotAuthor(author) };
    byKey.set(key, committer);
    const date = typeof git["date"] === "string" ? (git["date"] as string) : undefined;
    if (date) lastCommit.set(key, date);
  }
  return { committers: [...byKey.values()], lastCommit };
}

const keyOf = (c: Committer): string => c.login ?? `email:${c.email ?? ""}`;

/** The per-repo table: kernel precedence decides coverage, this maps it
 *  to the operator's state words (matching the roster's vocabulary). */
export function repoRow(
  repo: string,
  inScope: boolean,
  commits: Array<Record<string, unknown>>,
  snap: StoreSnapshot,
  cfg: Config,
  editions: Editions,
  window: number,
): RepoCoverageRow {
  const { committers, lastCommit } = sampleCommitters(commits, window);
  const org = repo.split("/")[0] ?? "";
  const name = repo.split("/")[1] ?? "";
  const verdict = evaluate({ context: { org, repo: name, pr: 0 }, committers }, snap, cfg, editions);
  const ids = committers.filter((c) => !c.isBot);

  const rows: ContributorRow[] = [];
  let i = 0;
  for (const c of committers) {
    const base = { login: c.login, email: c.email ?? null, last_commit: lastCommit.get(keyOf(c)) };
    if (c.isBot) {
      rows.push({ ...base, state: "ci-account" });
      continue;
    }
    const v = verdict.committers[i++];
    if (!v) continue;
    if (v.status === "covered") {
      if (v.path === "allowlist") {
        rows.push({ ...base, state: "allowlist" });
      } else {
        rows.push({
          ...base,
          state: "signed",
          path: v.path,
          ...(v.agreement && "orgSlug" in v.agreement ? { org_slug: v.agreement.orgSlug } : {}),
          edition: v.agreement?.version,
          matched_by: v.matchedBy,
          ...(v.underSeparateAgreement ? { under_separate_agreement: true } : {}),
        });
      }
    } else if (v.status === "must-specify") {
      rows.push({
        ...base,
        state: "must-specify",
        matched_by: v.matchedBy,
        options: v.options.map((o) => (o.kind === "icla" ? `icla ${o.version}` : `${o.orgSlug} ocla ${o.version}`)),
      });
    } else {
      // Missing: a record may exist but be stale (an older edition) — the
      // operator needs that difference, "never signed" vs "signed an old one".
      const historical = hasHistoricalRecord(c, snap);
      rows.push({ ...base, state: historical.icla || historical.ocla ? "stale" : "outstanding" });
    }
  }
  return { repo, in_scope: inScope, contributors: rows };
}

export async function repoCoverageStep(
  deps: EnforcementDeps,
  installationId: number,
  cursor: CoverageCursor = { page: 1, offset: 0 },
  chunk: number = DEFAULT_REPOS_PER_STEP,
  window: number = DEFAULT_COMMIT_WINDOW,
): Promise<RepoCoverageReport> {
  const list = await deps.api.request(installationId, "GET", `/installation/repositories?per_page=${PER_PAGE}&page=${cursor.page}`);
  if (list.status !== 200) throw new Error(`installation repository listing failed: ${list.status}`);
  const body = JSON.parse(list.body) as { total_count?: number; repositories?: Array<{ full_name?: string }> };
  const page = (body.repositories ?? []).map((r) => r.full_name).filter((n): n is string => typeof n === "string");
  const slice = page.slice(cursor.offset, cursor.offset + chunk);

  const editions = kernelEditions(deps.config);
  const loaded = await loadSnapshot(
    { listRecords: makeListRecords(deps.api, deps.config.github.dataInstallationId, deps.config.github.dataRepo) },
    editions,
  );
  const { snapshot } = loaded;
  // The separate-agreement registry is static config since #89 — inject it
  // exactly as the enforcement path does, or the flag is dead code here.
  snapshot.msaLogins = deps.config.instance.separateAgreement?.logins ?? [];

  const repos: RepoCoverageRow[] = [];
  for (const repo of slice) {
    const inScope = !deps.config.coverage.reposWithoutCla.includes(repo.toLowerCase());
    if (!inScope) {
      // Excluded by config: enforcement does not apply, so the people are
      // not relevant to the operator's question — the posture is.
      repos.push({ repo, in_scope: false, contributors: [] });
      continue;
    }
    const res = await deps.api.request(installationId, "GET", `/repos/${repo}/commits?per_page=${window}`);
    if (res.status !== 200) {
      repos.push({
        repo,
        in_scope: true,
        note: res.status === 409 ? "empty repository (no commits)" : `commit listing failed: ${res.status}`,
        contributors: [],
      });
      continue;
    }
    repos.push(repoRow(repo, true, JSON.parse(res.body), snapshot, deps.config, editions, window));
  }

  const consumed = cursor.offset + slice.length;
  const next: CoverageCursor | null =
    page.length === 0 || (consumed >= page.length && page.length < PER_PAGE)
      ? null
      : consumed >= page.length
        ? { page: cursor.page + 1, offset: 0 }
        : { page: cursor.page, offset: consumed };
  return {
    org: slice[0]?.split("/")[0] ?? null,
    total: body.total_count ?? page.length,
    repos,
    next,
    window,
    notes: [
      // A store that loaded nothing reads as "everyone outstanding" — a
      // whole-estate gap that looks like ordinary drift. The report says
      // what it actually loaded, and names rejected records (fail-visible).
      `records loaded: ${snapshot.iclas.length} ICLA, ${snapshot.oclas.length} OCLA${loaded.rejected.length > 0 ? `; ${loaded.rejected.length} rejected: ${loaded.rejected.slice(0, 5).map((r) => `${r.path} (${r.reason})`).join(", ")}` : ""}`,
      "required-check status is not readable by the App (it holds no administration permission) — tracked per repo in riboseinc/cla#53",
      "excluded repositories (coverage.repos_without_cla) are reported with in_scope=false and no contributors",
    ],
  };
}
