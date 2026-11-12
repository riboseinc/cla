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
  return { committers: [...byKey.values()], truncated };
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
