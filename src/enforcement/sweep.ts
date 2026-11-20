import { GENERATED_CONFIG } from "../generated/config";
import { TOKEN_CACHE, ETAG_CACHE } from "../cache";
import { GithubApi } from "../github/api";
import { portalApi } from "../portal/helpers";
import { claimSweep, completeSweep, saveSweepCursor, enqueueSweep, openPrsForLogin, upsertOpenPr, type D1Like } from "../store/db";
import type { Env } from "../env";
import { evaluatePullRequest, type EnforcementDeps } from "./handler";
import type { FetchLike } from "../github/api";
import { fetchPrHeadSha } from "../github/pulls";

/**
 * The write-back sweep (issue #59): when a record lands that changes a
 * login's coverage, every OPEN pull request authored by that login
 * re-evaluates without waiting for a push. One invocation runs ONE
 * bounded step (one login, a subrequest budget shared across
 * installations); the cursor persists in D1, and the next tick or
 * admin call continues — idempotent, safe to retry.
 */

const CALL_BUDGET = 35;

export async function enqueueSweepFor(env: Env, logins: string[]): Promise<void> {
  const db = env.DB;
  if (!db) return;
  for (const login of logins) {
    if (login) await enqueueSweep(db, login);
  }
}

export type SweepCursor = { instIndex: number; repoIndex: number; repos: string[] };

/** The installation's open-pull-request enumeration for one login: the
 *  GitHub Search API returns nothing on installation tokens, so the
 *  walk is per repository — list the installation's repositories, then
 *  each repository's open pulls, filtering by author. Bounded by the
 *  shared call budget; the cursor resumes exactly where the walk
 *  stopped. */
export async function sweepLogin(deps: EnforcementDeps, login: string, cursor: { instIndex: number; repoIndex: number; repos: string[] } | undefined, db?: D1Like): Promise<{ cursor: SweepCursor | null; evaluated: string[]; failed: string[] }> {
  const evaluated: string[] = [];
  const failed: string[] = [];
  let calls = 0;
  // The indexed fast path (rnpgp/rnp#2587): PRs opened after this feature
  // are in the D1 open_prs index, so the sweep evaluates the login's own
  // pull requests directly — no installation/repository enumeration. The
  // legacy walk below stays as the fallback for PRs opened before the
  // index existed, and it feeds the index as it discovers them, so the
  // estate converges onto the fast path organically.
  if (db && (!cursor || cursor.instIndex === -1)) {
    const indexed = await openPrsForLogin(db, login);
    if (indexed.length > 0) {
      const start = cursor && cursor.instIndex === -1 ? (cursor.repoIndex ?? 0) : 0;
      for (let k = start; k < indexed.length; k++) {
        const row = indexed[k]!;
        if (calls >= CALL_BUDGET) return { cursor: { instIndex: -1, repoIndex: k, repos: [] }, evaluated, failed };
        calls += 1;
        try {
          const sha = row.headSha ?? (await fetchPrHeadSha(deps.api, row.installationId, row.repo, row.pr));
          calls += 1;
          const r = await evaluatePullRequest(deps, { installationId: row.installationId, repoFullName: row.repo, prNumber: row.pr, headSha: sha });
          evaluated.push(`${row.repo}#${row.pr} (${r.outcome})`);
        } catch (e) {
          failed.push(`${row.repo}#${row.pr}: ${(e as Error).message}`);
        }
      }
      return { cursor: null, evaluated, failed };
    }
  }
  const insts = await deps.api.appRequest("GET", "/app/installations?per_page=100");
  if (insts.status !== 200) throw new Error(`installation listing failed: ${insts.status}`);
  const installations = (JSON.parse(insts.body) as { installations?: Array<{ id: number; account?: { login?: string } }> }).installations ?? [];
  const start = cursor?.instIndex ?? 0;
  for (let i = start; i < installations.length; i++) {
    const inst = installations[i]!;
    if (calls >= CALL_BUDGET) return { cursor: { instIndex: i, repoIndex: 0, repos: [] }, evaluated, failed };
    // the installation's repositories: cached in the cursor when resuming
    let repos = cursor && cursor.instIndex === i && cursor.repos.length > 0 ? cursor.repos : undefined;
    if (!repos) {
      calls++;
      const list = await deps.api.request(inst.id, "GET", "/installation/repositories?per_page=100");
      if (list.status !== 200) {
        failed.push(`${inst.account?.login ?? inst.id}: repositories ${list.status}`);
        continue;
      }
      repos = (JSON.parse(list.body) as { repositories?: Array<{ full_name?: string }> }).repositories?.map((r) => r.full_name ?? "").filter(Boolean) ?? [];
    }
    const repoStart = cursor && cursor.instIndex === i ? (cursor.repoIndex ?? 0) : 0;
    for (let j = repoStart; j < repos.length; j++) {
      const repoFull = repos[j]!;
      if (calls >= CALL_BUDGET) return { cursor: { instIndex: i, repoIndex: j, repos }, evaluated, failed };
      calls++;
      const pulls = await deps.api.request(inst.id, "GET", `/repos/${repoFull}/pulls?state=open&per_page=50`);
      if (pulls.status !== 200) {
        failed.push(`${repoFull}: pulls ${pulls.status}`);
        continue;
      }
      const opens = (JSON.parse(pulls.body) as Array<{ number?: number; user?: { login?: string } }>).filter((p) => p.user?.login?.toLowerCase() === login.toLowerCase() && typeof p.number === "number");
      for (const p of opens) {
        if (db) {
          try {
            await upsertOpenPr(db, { repo: repoFull, pr: p.number!, login, installationId: inst.id, headSha: null });
          } catch {
            // index upkeep is best-effort: the walk proceeds either way
          }
        }
        try {
          const sha = await fetchPrHeadSha(deps.api, inst.id, repoFull, p.number!);
          calls++;
          const r = await evaluatePullRequest(deps, { installationId: inst.id, repoFullName: repoFull, prNumber: p.number!, headSha: sha });
          evaluated.push(`${repoFull}#${p.number} (${r.outcome})`);
        } catch (e) {
          failed.push(`${repoFull}#${p.number}: ${(e as Error).message}`);
        }
        if (calls >= CALL_BUDGET) return { cursor: { instIndex: i, repoIndex: j, repos }, evaluated, failed };
      }
    }
  }
  return { cursor: null, evaluated, failed };
}

/** One bounded drain step: claim the oldest queued login, sweep it,
 *  complete or persist the cursor. Returns what happened (or that the
 *  queue is empty). */
export async function drainSweepStep(env: Env, fetcher: FetchLike = (url, init) => fetch(url, init)): Promise<{ drained?: string; evaluated?: string[]; failed?: string[]; done?: boolean; cursor?: unknown }> {
  const db = env.DB;
  if (!db) return { done: true };
  const claim = await claimSweep(db);
  if (!claim) return { done: true };
  const api = portalApi(env, fetcher, () => Date.now());
  const deps: EnforcementDeps = { api, config: GENERATED_CONFIG, attributionSecret: env.OIDC_CLIENT_SECRET };
  let cursor: { instIndex: number; repoIndex: number; repos: string[] } | undefined;
  if (typeof claim.cursor === "string" && claim.cursor) {
    try {
      cursor = JSON.parse(claim.cursor) as { instIndex: number; repoIndex: number; repos: string[] };
    } catch {
      cursor = undefined;
    }
  }
  const r = await sweepLogin(deps, claim.login, cursor, db);
  if (r.cursor) {
    await saveSweepCursor(db, claim.login, claim.attempts + 1, r.cursor);
    return { drained: claim.login, evaluated: r.evaluated, failed: r.failed, cursor: r.cursor };
  }
  await completeSweep(db, claim.login);
  return { drained: claim.login, evaluated: r.evaluated, failed: r.failed, done: true };
}
