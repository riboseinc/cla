import type { Committer } from "@riboseinc/cla-kernel";
import type { GithubApi } from "./api";

/**
 * Committer identification (docs/design.md §5): list PR commits, take
 * author logins, exclude bots, fall back to git author email when
 * GitHub can't link the commit. The pulls-commits endpoint caps at
 * 250; hitting the cap exactly marks the result truncated — the
 * handler fails the check honestly rather than evaluating a partial
 * authorship set.
 */

const isBot = (author: unknown): boolean => {
  if (!author || typeof author !== "object") return false;
  const a = author as Record<string, unknown>;
  if (a["type"] === "Bot") return true;
  const login = a["login"];
  return typeof login === "string" && login.endsWith("[bot]");
};

export type PrCommitters = {
  committers: Committer[];
  /** Exactly 250 commits returned — the endpoint's cap. Fail honestly. */
  truncated: boolean;
};

export async function fetchPrCommitters(api: GithubApi, installationId: number, repoFullName: string, prNumber: number): Promise<PrCommitters> {
  const res = await api.request(installationId, "GET", `/repos/${repoFullName}/pulls/${prNumber}/commits?per_page=250`);
  if (res.status !== 200) throw new Error(`pulls commits failed: ${res.status}`);
  const commits = JSON.parse(res.body) as Array<Record<string, unknown>>;
  const truncated = commits.length >= 250;
  return { committers: committersFromCommitList(commits), truncated };
}

const committersFromCommitList = (commits: Array<Record<string, unknown>>): Committer[] => {
  const byKey = new Map<string, Committer>();
  for (const c of commits) {
    if (isBot(c["author"])) continue;
    const gh = c["author"] && typeof c["author"] === "object" ? (c["author"] as Record<string, unknown>) : undefined;
    const gitAuthor = c["commit"] && typeof c["commit"] === "object" ? obj((c["commit"] as Record<string, unknown>)["author"]) : undefined;
    const login = typeof gh?.["login"] === "string" ? (gh["login"] as string) : null;
    const email = typeof gitAuthor?.["email"] === "string" ? (gitAuthor["email"] as string) : null;
    if (login === null && email === null) continue; // neither identity resolvable — nothing to evaluate
    const key = login ?? `email:${email}`;
    if (!byKey.has(key)) byKey.set(key, { login, email });
  }
  return [...byKey.values()];
};

/** Commits that LANDED on a branch (compare before...head): the
 *  default-branch push leg's committer source. The compare endpoint
 *  caps its commit list at 250; a larger `total_commits` marks the
 *  result truncated — the caller fails the check honestly. */
export type PushDiff = PrCommitters & { stats: { files: number; codeLines: number } | undefined };

export async function fetchPushDiff(api: GithubApi, installationId: number, repoFullName: string, before: string, headSha: string): Promise<PushDiff> {
  const res = await api.request(installationId, "GET", `/repos/${repoFullName}/compare/${before}...${headSha}`);
  if (res.status !== 200) throw new Error(`compare failed: ${res.status}`);
  const cmp = obj(JSON.parse(res.body));
  const commits = Array.isArray(cmp["commits"]) ? (cmp["commits"] as Array<Record<string, unknown>>) : [];
  const total = typeof cmp["total_commits"] === "number" ? (cmp["total_commits"] as number) : commits.length;
  const truncated = total > commits.length;
  const files = Array.isArray(cmp["files"]) ? (cmp["files"] as Array<Record<string, unknown>>) : [];
  let stats: PushDiff["stats"];
  if (files.length > 0) {
    let codeLines = 0;
    for (const f of files) codeLines += (typeof f["additions"] === "number" ? (f["additions"] as number) : 0) + (typeof f["deletions"] === "number" ? (f["deletions"] as number) : 0);
    stats = { files: files.length, codeLines };
  }
  return { committers: committersFromCommitList(commits), truncated, stats };
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

/** Head SHA of a PR (the re-check path after an attribution election). */
export async function fetchPrHeadSha(api: GithubApi, installationId: number, repoFullName: string, prNumber: number): Promise<string> {
  const res = await api.request(installationId, "GET", `/repos/${repoFullName}/pulls/${prNumber}`);
  if (res.status !== 200) throw new Error(`pull lookup failed: ${res.status}`);
  const head = obj(JSON.parse(res.body))["head"];
  const sha = head && typeof head === "object" ? (head as Record<string, unknown>)["sha"] : undefined;
  if (typeof sha !== "string") throw new Error("pull head carries no sha");
  return sha;
}

/** The PR's size (files changed, additions+deletions) — the
 *  proportionality control's input (issue #58). */
export async function fetchPrStats(api: GithubApi, installationId: number, repoFullName: string, prNumber: number): Promise<{ files: number; codeLines: number } | undefined> {
  const res = await api.request(installationId, "GET", `/repos/${repoFullName}/pulls/${prNumber}`);
  if (res.status !== 200) throw new Error(`pull lookup failed: ${res.status}`);
  const pr = obj(JSON.parse(res.body));
  const files = pr["changed_files"];
  const additions = pr["additions"];
  const deletions = pr["deletions"];
  if (typeof files !== "number" || typeof additions !== "number" || typeof deletions !== "number") return undefined;
  return { files, codeLines: additions + deletions };
}
