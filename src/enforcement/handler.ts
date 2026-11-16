import type { AgreementRef } from "@riboseinc/cla-kernel";
import type { FetchLike } from "../github/api";
import { evaluate } from "@riboseinc/cla-kernel";
import type { AppConfig } from "../config";
import { kernelEditions } from "../config";
import { loadSnapshot } from "../store/load";
import { fetchPrCommitters } from "../github/pulls";
import type { GithubApi } from "../github/api";
import { makeListRecords } from "../store/github-store";
import { checkRunBody, createCheckRun, commentBody, conclusionFor, upsertComment, retractCoverageComment, postClosingComment, closingComment, preRegisterCheck, CHECK_NAME } from "./checks";
import { signAttributionToken, optionKey } from "../portal/attribution";
import { signCompletionToken, isAgreeCommand } from "../portal/completion";

/**
 * The pull_request orchestration (docs/design.md §5). Every store or
 * GitHub failure propagates: the route maps it to an honest FAILING
 * check — fail-closed, never a silent pass.
 */

export type EnforcementDeps = {
  api: GithubApi;
  config: AppConfig;
  /** HMAC secret for attribution-link tokens (the identity secret). */
  attributionSecret?: string;
};

const CHECK_NAME_LOCAL = CHECK_NAME;

export async function evaluatePullRequest(
  deps: EnforcementDeps,
  args: { installationId: number; repoFullName: string; prNumber: number; headSha: string },
): Promise<{ handled: boolean; outcome: string }> {
  const full = args.repoFullName;
  const org = full.split("/")[0] ?? "";
  const repo = full.split("/")[1] ?? "";
  if (deps.config.coverage.reposWithoutCla.includes(full.toLowerCase())) {
    return { handled: false, outcome: "repo is in repos_without_cla (out of scope by config)" };
  }

  const { committers, truncated } = await fetchPrCommitters(deps.api, args.installationId, full, args.prNumber);
  if (truncated) {
    // Honest truncation: >250 commits is beyond the pulls endpoint cap —
    // never evaluate a partial authorship set as if it were whole.
    await createCheckRun(deps.api, args.installationId, full, args.headSha, {
      name: CHECK_NAME_LOCAL,
      status: "completed",
      conclusion: "failure",
      output: { title: `CLA (${CHECK_NAME_LOCAL})`, summary: "PR exceeds the 250-commit endpoint cap; authorship cannot be fully evaluated. Split the PR or ask the maintainers to evaluate manually." },
    });
    return { handled: true, outcome: "truncated-commits -> failing check" };
  }

  const editions = kernelEditions(deps.config);
  // Data-repo reads go through the installation that OWNS the data repo
  // (config's data_installation_id) — one app JWT mints tokens for any
  // of its installations; installations never span orgs.
  const loaded = await loadSnapshot(
    { listRecords: makeListRecords(deps.api, deps.config.github.dataInstallationId, deps.config.github.dataRepo) },
    editions,
  );
  const verdict = evaluate({ context: { org, repo, pr: args.prNumber }, committers }, loaded.snapshot, deps.config, editions);

  const portalBase = `https://${deps.config.instance.portalHost}`;
  const signingDocsUrl = deps.config.instance.signingDocsUrl;
  // must-specify logins get per-option signed links through the portal
  const attributionLinks: Record<string, Array<{ label: string; url: string }>> = {};
  for (const [loginL, options] of Object.entries(verdict.mustSpecify)) {
    if (!deps.attributionSecret) continue;
    const token = await signAttributionToken(deps.attributionSecret, { repo: full, pr: args.prNumber, login: loginL, installationId: args.installationId, options }, Date.now());
    attributionLinks[loginL] = options.map((o) => ({
      label: o.kind === "icla" ? "Individual CLA" : `${o.orgSlug} OCLA`,
      url: `${portalBase}/attribute?t=${token}&pick=${optionKey(o)}`,
    }));
  }
  await createCheckRun(deps.api, args.installationId, full, args.headSha, checkRunBody(verdict, portalBase, signingDocsUrl));
  if (conclusionFor(verdict) === "success") {
    // Silence when covered: the green required check is the record;
    // a comment left over from an earlier missing-state is retracted.
    await retractCoverageComment(deps.api, args.installationId, full, args.prNumber);
  } else {
    await upsertComment(deps.api, args.installationId, full, args.prNumber, commentBody(verdict, portalBase, { attributionLinks, signingDocsUrl }));
  }
  return { handled: true, outcome: `verdict=${verdict.verdict} missing=${verdict.missing.length} specify=${Object.keys(verdict.mustSpecify).length}` };
}

/** pull_request.closed + merged — the closing attribution statement (deduped). */
export async function closeMergedPullRequest(
  deps: EnforcementDeps,
  args: { installationId: number; repoFullName: string; prNumber: number },
): Promise<{ posted: boolean }> {
  const full = args.repoFullName;
  const org = full.split("/")[0] ?? "";
  const repo = full.split("/")[1] ?? "";
  if (deps.config.coverage.reposWithoutCla.includes(full.toLowerCase())) return { posted: false };

  const editions = kernelEditions(deps.config);
  const loaded = await loadSnapshot(
    { listRecords: makeListRecords(deps.api, deps.config.github.dataInstallationId, deps.config.github.dataRepo) },
    editions,
  );
  const { committers } = await fetchPrCommitters(deps.api, args.installationId, full, args.prNumber);
  const verdict = evaluate({ context: { org, repo, pr: args.prNumber }, committers }, loaded.snapshot, deps.config, editions);

  const elected: Record<string, AgreementRef> = {};
  for (const a of loaded.snapshot.attributions ?? []) {
    if (a.pr === args.prNumber && a.repo.toLowerCase() === full.toLowerCase() && !elected[a.login]) elected[a.login] = a.agreement;
  }
  // Silence on a clean merge: the green check on the merge commit is the
  // record, and a closing comment that re-mentions every covered committer
  // is noise on every single merge. The closing statement posts only when
  // it carries real information — elections recorded during review, or a
  // gap (someone merged without coverage, or an unresolved election).
  const hasElections = Object.keys(elected).length > 0;
  const hasGaps = verdict.missing.length > 0 || Object.keys(verdict.mustSpecify).length > 0;
  if (!hasElections && !hasGaps) return { posted: false };
  await postClosingComment(deps.api, args.installationId, full, args.prNumber, closingComment(verdict, elected));
  return { posted: true };
}

/** issue_comment.created — the `@ribose-cla agree` entry point (docs/design.md §3.12).
 *  Only PR authors/committers get a reply; everyone else is silently ignored. */
export async function handleAgreeCommand(
  deps: EnforcementDeps,
  args: { installationId: number; repoFullName: string; prNumber: number; commenter: string; prAuthor: string },
): Promise<{ replied: boolean; reason?: string }> {
  const full = args.repoFullName;
  const commenter = args.commenter.toLowerCase();

  const { committers } = await fetchPrCommitters(deps.api, args.installationId, full, args.prNumber);
  const logins = new Set<string>(committers.flatMap((c) => (c.login ? [c.login.toLowerCase()] : [])));
  logins.add(args.prAuthor.toLowerCase());
  if (!logins.has(commenter)) return { replied: false, reason: "not a committer (ignored)" };

  const editions = kernelEditions(deps.config);
  const { snapshot } = await loadSnapshot(
    { listRecords: makeListRecords(deps.api, deps.config.github.dataInstallationId, deps.config.github.dataRepo) },
    editions,
  );
  const currentIcla = snapshot.iclas.find((r) => r.githubLogin.toLowerCase() === commenter && r.edition.textSha256 === editions.icla.textSha256);
  if (currentIcla) {
    await postBotReply(deps.api, args.installationId, full, args.prNumber, `@${commenter} you already signed the Individual CLA v${currentIcla.edition.version} — you're covered.`);
    return { replied: true, reason: "already-signed" };
  }

  if (!deps.attributionSecret) return { replied: false, reason: "portal unconfigured (fail-closed)" };
  const token = await signCompletionToken(deps.attributionSecret, { repo: full, pr: args.prNumber, login: commenter }, Date.now());
  const portalBase = `https://${deps.config.instance.portalHost}`;
  await postBotReply(
    deps.api,
    args.installationId,
    full,
    args.prNumber,
    [
      `@${commenter} — almost done. Open this link to confirm your signature of the **Individual CLA v${deps.config.legal.current.icla}** (it states the full terms, and includes all your previous contributions unless you decline):`,
      ``,
      `${portalBase}/icla/complete?t=${token}`,
      ``,
      `_Your GitHub handle is already verified by this command; the link completes the signature record with your identity account._`,
    ].join("\n"),
  );
  return { replied: true, reason: "completion-link sent" };
}

async function postBotReply(api: GithubApi, installationId: number, repoFullName: string, prNumber: number, body: string): Promise<void> {
  const res = await api.request(installationId, "POST", `/repos/${repoFullName}/issues/${prNumber}/comments`, { body: { body } });
  if (res.status !== 201) throw new Error(`bot reply failed: ${res.status}`);
}
/**
 * Pre-registration is bounded because a single installation can cover a
 * whole large organisation: each repo costs four GitHub subrequests
 * (info, head, existing-run probe, create), so an unbounded loop over
 * hundreds of repos blows the invocation budget and never finishes.
 */
export const PRE_REGISTER_BATCH = 25;

export type PreRegisterOutcome = {
  done: string[];
  failed: Array<{ repo: string; reason: string }>;
  /** Repos this batch did not attempt — the caller finishes them. */
  deferred: string[];
};

/** installation_repositories.added / installation.created — pre-register a bounded batch. */
export async function preRegisterRepos(
  deps: EnforcementDeps,
  installationId: number,
  repos: string[],
  opts: { limit?: number } = {},
): Promise<PreRegisterOutcome> {
  const limit = opts.limit ?? PRE_REGISTER_BATCH;
  const wanted = repos.filter((repo) => !deps.config.coverage.reposWithoutCla.includes(repo.toLowerCase()));
  const batch = wanted.slice(0, limit);
  const outcome: PreRegisterOutcome = { done: [], failed: [], deferred: wanted.slice(limit) };
  for (const repo of batch) {
    try {
      await preRegisterCheck(deps.api, installationId, repo);
      outcome.done.push(repo);
    } catch (e) {
      // One repo's failure must not strand the rest of the installation;
      // the failures are reported, never swallowed.
      outcome.failed.push({ repo, reason: (e as Error).message });
    }
  }
  return outcome;
}

export type PreRegisterCursor = { page: number; offset: number };

/**
 * Finish pre-registration across a whole installation, one bounded step
 * at a time: walks `GET /installation/repositories` page by page, and
 * hands back the `next` cursor for the following call (null = done).
 * Steps are idempotent, so an interrupted or repeated backfill converges.
 * This is the completion path for orgs too large for one webhook delivery.
 */
export async function preRegisterInstallation(
  deps: EnforcementDeps,
  installationId: number,
  cursor: PreRegisterCursor = { page: 1, offset: 0 },
  chunk: number = PRE_REGISTER_BATCH,
): Promise<PreRegisterOutcome & { total: number; next: PreRegisterCursor | null }> {
  const PER_PAGE = 100;
  const list = await deps.api.request(installationId, "GET", `/installation/repositories?per_page=${PER_PAGE}&page=${cursor.page}`);
  if (list.status !== 200) throw new Error(`installation repository listing failed: ${list.status}`);
  const body = JSON.parse(list.body) as { total_count?: number; repositories?: Array<{ full_name?: string }> };
  const page = (body.repositories ?? []).map((r) => r.full_name).filter((n): n is string => typeof n === "string");
  const slice = page.slice(cursor.offset, cursor.offset + chunk);
  const outcome = await preRegisterRepos(deps, installationId, slice, { limit: chunk });

  const consumed = cursor.offset + slice.length;
  const next: PreRegisterCursor | null =
    page.length === 0 || (consumed >= page.length && page.length < PER_PAGE)
      ? null
      : consumed >= page.length
        ? { page: cursor.page + 1, offset: 0 }
        : { page: cursor.page, offset: consumed };
  return { ...outcome, total: body.total_count ?? page.length, next };
}
