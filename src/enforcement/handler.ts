import type { AgreementRef } from "@riboseinc/cla-kernel";
import type { FetchLike } from "../github/api";
import { evaluate } from "@riboseinc/cla-kernel";
import type { AppConfig } from "../config";
import { kernelEditions } from "../config";
import { loadSnapshot } from "../store/load";
import { fetchPrCommitters, fetchPrStats, fetchPrHeadSha } from "../github/pulls";
import type { GithubApi } from "../github/api";
import { makeListRecords } from "../store/github-store";
import { appendRecord } from "../store/write";
import { randomToken } from "../portal/github-oauth";
import { checkRunBody, createCheckRun, commentBody, conclusionFor, upsertComment, retractCoverageComment, postClosingComment, closingComment, preRegisterCheck, CHECK_NAME } from "./checks";
import { signAttributionToken, optionKey } from "../portal/attribution";
import { signCompletionToken, parseAgreeCommand, parseThirdPartyCommand, type AgreeCommand } from "../portal/completion";

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
  /** The join-request queue, injected by the app (it owns D1 + mail):
   *  files a pending request for the org's PoC console. Unset: the
   *  queue is unavailable and the command answers honestly. */
  requestJoin?: (oclaId: string, login: string) => Promise<{ requested: boolean }>;
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
  const diff = await fetchPrStats(deps.api, args.installationId, full, args.prNumber);
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
  const verdict = evaluate({ context: { org, repo, pr: args.prNumber }, committers, diff }, loaded.snapshot, deps.config, editions);

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
  const diff = await fetchPrStats(deps.api, args.installationId, full, args.prNumber);
  const verdict = evaluate({ context: { org, repo, pr: args.prNumber }, committers, diff }, loaded.snapshot, deps.config, editions);

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
  const hasGaps = verdict.missing.length > 0 || Object.keys(verdict.mustSpecify).length > 0 || verdict.minimalChange === true;
  const onBehalf = (loaded.snapshot.thirdParties ?? []).find((t) => t.pr === args.prNumber && t.repo.toLowerCase() === full.toLowerCase())?.name;
  if (!hasElections && !hasGaps && !onBehalf) return { posted: false };
  await postClosingComment(deps.api, args.installationId, full, args.prNumber, closingComment(verdict, elected, onBehalf));
  return { posted: true };
}

/** issue_comment.created — the `@ribose-cla` command grammar
 *  (docs/design.md §3.12 + issue #57). Only PR authors/committers get
 *  a reply; everyone else is silently ignored. A comment never grants
 *  coverage by self-declaration: `icla` elects only when the kernel's
 *  live paths offer the ICLA, and `company` elects only against the
 *  org's effective Schedule A — otherwise it files a join request. */
/** issue_comment.created - the clause-7 declaration (issue #63): the
 *  committer declares the work is submitted on behalf of a named third
 *  party. The declaration is recorded append-only, the PR body gains
 *  the conspicuous marking (appended only when absent), and the reply
 *  states the obligations. Coverage is unchanged: the committer's own
 *  ICLA still gates the check. */
export async function handleThirdPartyCommand(
  deps: EnforcementDeps,
  args: { installationId: number; repoFullName: string; prNumber: number; commenter: string; prAuthor: string; body: string },
): Promise<{ replied: boolean; reason?: string }> {
  const full = args.repoFullName;
  const commenter = args.commenter.toLowerCase();
  const name = parseThirdPartyCommand(args.body);
  if (!name) return { replied: false, reason: "not a command (ignored)" };

  const { committers } = await fetchPrCommitters(deps.api, args.installationId, full, args.prNumber);
  const logins = new Set<string>(committers.flatMap((c) => (c.login ? [c.login.toLowerCase()] : [])));
  logins.add(args.prAuthor.toLowerCase());
  if (!logins.has(commenter)) return { replied: false, reason: "not a committer (ignored)" };

  await appendRecord(
    { api: deps.api, installationId: deps.config.github.dataInstallationId, dataRepo: deps.config.github.dataRepo, now: () => Date.now() },
    "third_party",
    { id: randomToken(), repo: full, pr: args.prNumber, login: commenter, name, recorded_at: new Date().toISOString() },
  );

  // The conspicuous marking lives in the PR body (clause 7): append the
  // line when absent; a body that already carries it is left alone.
  const prRes = await deps.api.request(args.installationId, "GET", `/repos/${full}/pulls/${args.prNumber}`);
  if (prRes.status !== 200) throw new Error(`pull lookup failed: ${prRes.status}`);
  const prBody = (JSON.parse(prRes.body) as { body?: string }).body ?? "";
  const MARKING = `Submitted on behalf of a third-party: ${name}`;
  if (!prBody.includes("Submitted on behalf of a third-party:")) {
    const patched = await deps.api.request(args.installationId, "PATCH", `/repos/${full}/pulls/${args.prNumber}`, {
      body: { body: `${prBody}${prBody ? "\n\n" : ""}${MARKING}` },
    });
    if (patched.status !== 200) throw new Error(`pull body patch failed: ${patched.status}`);
  }

  const portalBase = `https://${deps.config.instance.portalHost}`;
  await postBotReply(
    deps.api,
    args.installationId,
    full,
    args.prNumber,
    [
      `@${commenter} recorded: this pull request declares **${MARKING}**. The marking is in the pull request description, as the Agreement's third-party clause requires.`,
      ``,
      `The obligations in plain sentences: the work must not be your original creation, the source and its license must be identified in the pull request, and the marking must stay conspicuous. This declaration does not replace your own agreement - your signed Individual CLA still gates this pull request.`,
      ``,
      `No Individual CLA on record? [Sign it here](${portalBase}/icla) - the declaration carries the attribution; the signature carries the coverage.`,
    ].join("\n"),
  );
  return { replied: true, reason: "third-party declaration recorded" };
}

export async function handleAgreeCommand(
  deps: EnforcementDeps,
  args: { installationId: number; repoFullName: string; prNumber: number; commenter: string; prAuthor: string; body: string },
): Promise<{ replied: boolean; reason?: string }> {
  const full = args.repoFullName;
  const commenter = args.commenter.toLowerCase();
  const command = parseAgreeCommand(args.body);
  if (!command) return { replied: false, reason: "not a command (ignored)" };

  const { committers } = await fetchPrCommitters(deps.api, args.installationId, full, args.prNumber);
  const logins = new Set<string>(committers.flatMap((c) => (c.login ? [c.login.toLowerCase()] : [])));
  logins.add(args.prAuthor.toLowerCase());
  if (!logins.has(commenter)) return { replied: false, reason: "not a committer (ignored)" };

  const editions = kernelEditions(deps.config);
  const { snapshot } = await loadSnapshot(
    { listRecords: makeListRecords(deps.api, deps.config.github.dataInstallationId, deps.config.github.dataRepo) },
    editions,
  );

  if (command.kind === "icla-completion") {
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

  // `agree icla` / `agree company=...`: comment-driven attribution
  // elections against the LIVE paths (the same safety as the signed
  // /attribute link), then an immediate re-check.
  const api = deps.api;
  const { committers: evalCommitters, truncated } = await fetchPrCommitters(api, args.installationId, full, args.prNumber);
  const diff = await fetchPrStats(api, args.installationId, full, args.prNumber);
  const verdict = evaluate(
    { context: { org: full.split("/")[0] ?? "", repo: full.split("/")[1] ?? "", pr: args.prNumber }, committers: evalCommitters, ...(diff ? { diff } : {}) },
    snapshot,
    deps.config,
    editions,
  );
  const mine = verdict.committers.find((c) => c.login?.toLowerCase() === commenter);

  const elect = async (agreement: AgreementRef, label: string): Promise<{ replied: boolean; reason: string }> => {
    await appendRecord(
      { api, installationId: deps.config.github.dataInstallationId, dataRepo: deps.config.github.dataRepo, now: () => Date.now() },
      "attribution",
      { id: randomToken(), repo: full, pr: args.prNumber, login: commenter, agreement, recorded_at: new Date().toISOString() },
    );
    const sha = await fetchPrHeadSha(api, args.installationId, full, args.prNumber);
    await evaluatePullRequest(deps, { installationId: args.installationId, repoFullName: full, prNumber: args.prNumber, headSha: sha });
    await postBotReply(api, args.installationId, full, args.prNumber, `@${commenter} recorded — this pull request is contributed under **${label}**. The check re-ran and reflects it.`);
    return { replied: true, reason: "election recorded" };
  };

  if (command.kind === "icla-elect") {
    if (mine?.status === "covered") {
      await postBotReply(api, args.installationId, full, args.prNumber, `@${commenter} you're already covered on this pull request (${mine.path}) — no election needed.`);
      return { replied: true, reason: "already covered" };
    }
    const iclaOption = mine?.status === "must-specify" ? mine.options.find((o) => o.kind === "icla") : undefined;
    if (!iclaOption) {
      await postBotReply(api, args.installationId, full, args.prNumber, `@${commenter} the Individual CLA is not among your coverage options for this pull request${mine?.status === "missing" ? " — [sign the ICLA](https://" + deps.config.instance.portalHost + "/icla) first" : ""}.`);
      return { replied: true, reason: "icla not among options" };
    }
    return elect(iclaOption, `the Individual CLA v${iclaOption.version}`);
  }

  // company election / join request
  const orgSlug = command.company.toLowerCase();
  const ocla = snapshot.oclas.find((o) => o.orgSlug.toLowerCase() === orgSlug);
  if (!ocla) {
    await postBotReply(api, args.installationId, full, args.prNumber, `@${commenter} no Organization CLA exists for "${command.company}". [See the organizations page](https://${deps.config.instance.portalHost}/organizations).`);
    return { replied: true, reason: "no such organization" };
  }
  const onRoster = ocla.covered.some((r) => r.githubLogin.toLowerCase() === commenter);
  if (!onRoster) {
    if (!deps.requestJoin) {
      await postBotReply(api, args.installationId, full, args.prNumber, `@${commenter} you are not on ${ocla.orgSlug}'s Schedule A. The join queue is temporarily unavailable — ask ${ocla.orgSlug}'s Point of Contact to add you.`);
      return { replied: true, reason: "join queue unavailable" };
    }
    const r = await deps.requestJoin(ocla.id, commenter);
    await postBotReply(
      api,
      args.installationId,
      full,
      args.prNumber,
      `@${commenter} you are not on ${ocla.orgSlug}'s Schedule A${r.requested ? ` — a join request was sent to ${ocla.orgSlug}'s Point of Contact. Once they approve it, this check turns green on its own. A comment never grants coverage by itself: the Schedule A is the boundary.` : " — a join request is already pending with the Point of Contact."}`,
    );
    return { replied: true, reason: r.requested ? "join request sent" : "join request already pending" };
  }
  if (mine?.status === "covered") {
    await postBotReply(api, args.installationId, full, args.prNumber, `@${commenter} you're already covered on this pull request (${mine.path}) — no election needed.`);
    return { replied: true, reason: "already covered" };
  }
  const oclaOption = mine?.status === "must-specify" ? mine.options.find((o) => o.kind === "ocla" && o.orgSlug.toLowerCase() === orgSlug) : undefined;
  if (!oclaOption) {
    // on the roster but the live edition disagrees (stale OCLA) — honest answer
    await postBotReply(api, args.installationId, full, args.prNumber, `@${commenter} ${ocla.orgSlug}'s OCLA does not currently offer live coverage on this pull request (its edition may be stale).`);
    return { replied: true, reason: "ocla not among live options" };
  }
  return elect(oclaOption, `the ${ocla.orgSlug} OCLA v${oclaOption.version}`);
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
