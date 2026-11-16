import { GENERATED_CONFIG } from "../generated/config";
import { TOKEN_CACHE, ETAG_CACHE } from "../cache";
import { GithubApi } from "../github/api";
import { portalApi } from "../portal/helpers";
import { claimSweep, completeSweep, saveSweepCursor, enqueueSweep } from "../store/db";
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

export async function sweepLogin(deps: EnforcementDeps, login: string, cursor: { instIndex: number } | undefined): Promise<{ cursor: { instIndex: number } | null; evaluated: string[]; failed: string[] }> {
  const evaluated: string[] = [];
  const failed: string[] = [];
  let calls = 0;
  const insts = await deps.api.appRequest("GET", "/app/installations?per_page=100");
  if (insts.status !== 200) throw new Error(`installation listing failed: ${insts.status}`);
  const installations = (JSON.parse(insts.body) as { installations?: Array<{ id: number; account?: { login?: string } }> }).installations ?? [];
  const start = cursor?.instIndex ?? 0;
  for (let i = start; i < installations.length; i++) {
    const inst = installations[i]!;
    const org = inst.account?.login;
    if (!org) continue;
    if (calls >= CALL_BUDGET) return { cursor: { instIndex: i }, evaluated, failed };
    calls++;
    const search = await deps.api.request(inst.id, "GET", `/search/issues?q=${encodeURIComponent(`is:pr is:open author:${login} org:${org}`)}&per_page=50`);
    if (search.status !== 200) {
      failed.push(`${org}: search ${search.status}`);
      continue;
    }
    const items = (JSON.parse(search.body) as { items?: Array<{ number?: number; repository_url?: string }> }).items ?? [];
    for (const item of items) {
      const number = item.number;
      const repoFull = item.repository_url?.split("/repos/")[1];
      if (typeof number !== "number" || !repoFull) continue;
      try {
        const sha = await fetchPrHeadSha(deps.api, inst.id, repoFull, number);
        calls++;
        const r = await evaluatePullRequest(deps, { installationId: inst.id, repoFullName: repoFull, prNumber: number, headSha: sha });
        evaluated.push(`${repoFull}#${number} (${r.outcome})`);
      } catch (e) {
        failed.push(`${repoFull}#${number}: ${(e as Error).message}`);
      }
      if (calls >= CALL_BUDGET) return { cursor: { instIndex: i }, evaluated, failed };
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
  let cursor: { instIndex: number } | undefined;
  if (typeof claim.cursor === "string" && claim.cursor) {
    try {
      cursor = JSON.parse(claim.cursor) as { instIndex: number };
    } catch {
      cursor = undefined;
    }
  }
  const r = await sweepLogin(deps, claim.login, cursor);
  if (r.cursor) {
    await saveSweepCursor(db, claim.login, claim.attempts + 1, r.cursor);
    return { drained: claim.login, evaluated: r.evaluated, failed: r.failed, cursor: r.cursor };
  }
  await completeSweep(db, claim.login);
  return { drained: claim.login, evaluated: r.evaluated, failed: r.failed, done: true };
}
