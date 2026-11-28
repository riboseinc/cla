import type { AgreementRef } from "@riboseinc/cla-kernel";
import type { FetchLike } from "../github/api";
import { evaluate } from "@riboseinc/cla-kernel";
import type { AppConfig } from "../config";
import { kernelEditions } from "../config";
import { loadSnapshot, oclaForSlug } from "../store/load";
import { fetchPrCommitters, fetchPrStats, fetchPrHeadSha, fetchPushDiff } from "../github/pulls";
import type { GithubApi } from "../github/api";
import { makeListRecords } from "../store/github-store";
import { appendRecord } from "../store/write";
import { randomToken } from "../portal/github-oauth";
import { checkRunBody, createCheckRun, commentBody, conclusionFor, upsertComment, retractCoverageComment, postClosingComment, closingComment, preRegisterCheck, staleDeploymentBody, CHECK_NAME } from "./checks";
import { signAttributionToken, optionKey } from "../portal/attribution";
import { signCompletionToken, thirdPartyGate, type AgreeCommand, type ThirdPartyParse, type MetaCommand } from "../portal/completion";
import { iclaRecordId } from "../portal/helpers";
import { evaluateWithOrgMembership, resolveOrgMemberships } from "./org-membership";

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
  loaded.snapshot.msaLogins = deps.config.instance.separateAgreement?.logins ?? [];
  loaded.snapshot.msaEmails = deps.config.instance.separateAgreement?.emails ?? [];
  // A stale deployment makes every record of the current edition read as
  // not-live: the verdict would be a false "missing" and the comment would
  // ask a covered contributor to sign what they already signed (issue
  // #104). Name the deployment, fail closed, blame no person.
  if (loaded.editionDivergences.length > 0) {
    const d = loaded.editionDivergences[0]!;
    await createCheckRun(deps.api, args.installationId, full, args.headSha, staleDeploymentBody(d));
    await retractCoverageComment(deps.api, args.installationId, full, args.prNumber);
    return {
      handled: true,
      outcome: `stale-deployment: ${d.path} declares ${d.kind} v${d.version} sha ${d.recordSha256.slice(0, 8)}, this deploy compiled ${d.currentSha256.slice(0, 8)}`,
    };
  }
  const verdict = await evaluateWithOrgMembership(deps.api, deps.config, loaded.snapshot, () =>
    evaluate({ context: { org, repo, pr: args.prNumber }, committers, diff }, loaded.snapshot, deps.config, editions),
  );

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
    // The stale-edition hint (issue #60): a committer whose signature
    // exists but predates the current edition reads WHY they are asked
    // again, not just that they are. An organization agreement goes stale
    // the same way (issue #123) — its Schedule A members are uncovered
    // until the signatory re-executes, and telling them only "sign the
    // ICLA" hides the reason and the real remedy.
    const staleEditions: Record<string, { signed: string; current: string }> = {};
    const staleOclas: Record<string, { orgSlug: string; signed: string; current: string; viaOrgMembership?: boolean }> = {};
    for (const login of verdict.missing) {
      const stale = loaded.snapshot.iclas.find((r) => r.githubLogin.toLowerCase() === login.toLowerCase() && r.edition.textSha256 !== editions.icla.textSha256);
      if (stale) {
        staleEditions[login] = { signed: stale.edition.version, current: editions.icla.version };
        // A re-signable ICLA is the person's own action; it names the remedy.
        continue;
      }
      // Creation order: the LAST superseded record covering the login is the newest.
      const superseded = [...loaded.snapshot.oclas]
        .reverse()
        .find((o) => o.edition.textSha256 !== editions.ocla.textSha256 && o.covered.some((row) => row.githubLogin.toLowerCase() === login.toLowerCase()));
      if (superseded) {
        staleOclas[login] = { orgSlug: superseded.orgSlug, signed: superseded.edition.version, current: editions.ocla.version };
        continue;
      }
      // A member of a MAPPED GitHub org reads the same way when the
      // mapped OCLA goes stale (issue #16 item 4): their coverage
      // stopped because the instrument did, and the generic "sign the
      // ICLA" hides that reason and the real remedy — the same honesty
      // #123 gave named Schedule A rows.
      const mappedSlugs = (loaded.snapshot.orgMembers ?? [])
        .filter((m) => m.login.toLowerCase() === login.toLowerCase())
        .map((m) => deps.config.coverage.orgMembership?.[m.org.toLowerCase()])
        .filter((s): s is string => Boolean(s));
      const staleViaMembership = [...loaded.snapshot.oclas]
        .reverse()
        .find((o) => o.edition.textSha256 !== editions.ocla.textSha256 && mappedSlugs.includes(o.orgSlug.toLowerCase()));
      if (staleViaMembership) {
        staleOclas[login] = { orgSlug: staleViaMembership.orgSlug, signed: staleViaMembership.edition.version, current: editions.ocla.version, viaOrgMembership: true };
      }
    }
    await upsertComment(deps.api, args.installationId, full, args.prNumber, commentBody(verdict, portalBase, { attributionLinks, signingDocsUrl, staleEditions, staleOclas }));
  }
  return { handled: true, outcome: `verdict=${verdict.verdict} missing=${verdict.missing.length} specify=${Object.keys(verdict.mustSpecify).length} records=${loaded.snapshot.iclas.length}I/${loaded.snapshot.oclas.length}O editions=${editions.icla.textSha256.slice(0, 8)}/${editions.ocla.textSha256.slice(0, 8)}` };
}

/**
 * check_suite.requested on the DEFAULT branch — commits that landed
 * outside any pull request this App evaluated: advisory merges (whose
 * pull requests live in temporary private forks no integration can
 * see), merge commits pushed by VCS bridges, direct admin pushes.
 * Same kernel, same fail-closed posture; there is no PR thread, so
 * the verdict lands only as the check run — the record a required
 * check can demand at merge time.
 */
export async function evaluateDefaultBranchPush(
  deps: EnforcementDeps,
  args: { installationId: number; repoFullName: string; headSha: string; before: string },
): Promise<{ handled: boolean; outcome: string }> {
  const full = args.repoFullName;
  const org = full.split("/")[0] ?? "";
  const repo = full.split("/")[1] ?? "";
  if (deps.config.coverage.reposWithoutCla.includes(full.toLowerCase())) {
    return { handled: false, outcome: "repo is in repos_without_cla (out of scope by config)" };
  }
  if (!args.before || /^0+$/.test(args.before)) {
    return { handled: false, outcome: "branch created; nothing to evaluate" };
  }

  const push = await fetchPushDiff(deps.api, args.installationId, full, args.before, args.headSha);
  if (push.truncated) {
    await createCheckRun(deps.api, args.installationId, full, args.headSha, {
      name: CHECK_NAME_LOCAL,
      status: "completed",
      conclusion: "failure",
      output: { title: `CLA (${CHECK_NAME_LOCAL})`, summary: "The push exceeds the compare endpoint's commit cap; authorship cannot be fully evaluated. Ask the maintainers to evaluate manually." },
    });
    return { handled: true, outcome: "truncated-push -> failing check" };
  }

  const editions = kernelEditions(deps.config);
  const loaded = await loadSnapshot(
    { listRecords: makeListRecords(deps.api, deps.config.github.dataInstallationId, deps.config.github.dataRepo) },
    editions,
  );
  loaded.snapshot.msaLogins = deps.config.instance.separateAgreement?.logins ?? [];
  loaded.snapshot.msaEmails = deps.config.instance.separateAgreement?.emails ?? [];
  if (loaded.editionDivergences.length > 0) {
    const d = loaded.editionDivergences[0]!;
    await createCheckRun(deps.api, args.installationId, full, args.headSha, staleDeploymentBody(d));
    return {
      handled: true,
      outcome: `stale-deployment: ${d.path} declares ${d.kind} v${d.version} sha ${d.recordSha256.slice(0, 8)}, this deploy compiled ${d.currentSha256.slice(0, 8)}`,
    };
  }
  const verdict = await evaluateWithOrgMembership(deps.api, deps.config, loaded.snapshot, () =>
    evaluate({ context: { org, repo }, committers: push.committers, diff: push.stats }, loaded.snapshot, deps.config, editions),
  );
  await createCheckRun(deps.api, args.installationId, full, args.headSha, checkRunBody(verdict, `https://${deps.config.instance.portalHost}`, deps.config.instance.signingDocsUrl));
  return { handled: true, outcome: `verdict=${verdict.verdict} missing=${verdict.missing.length} specify=${Object.keys(verdict.mustSpecify).length}` };
}

/** pull_request.closed + merged — the closing attribution statement (deduped). */export async function closeMergedPullRequest(
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
  // The closing statement is the public attribution record (append-only):
  // a stale deployment would read covered committers as uncovered and
  // write "merged without CLA coverage" about them. Refuse, loudly — the
  // webhook retries after a correct deploy (issue #104).
  if (loaded.editionDivergences.length > 0) {
    const d = loaded.editionDivergences[0]!;
    throw new Error(
      `refusing to post an attribution statement from a stale deployment: ${d.path} declares ${d.kind} v${d.version} sha ${d.recordSha256.slice(0, 8)}, this deploy compiled ${d.currentSha256.slice(0, 8)}`,
    );
  }
  const { committers } = await fetchPrCommitters(deps.api, args.installationId, full, args.prNumber);
  const diff = await fetchPrStats(deps.api, args.installationId, full, args.prNumber);
  loaded.snapshot.msaLogins = deps.config.instance.separateAgreement?.logins ?? [];
  loaded.snapshot.msaEmails = deps.config.instance.separateAgreement?.emails ?? [];
  const verdict = await evaluateWithOrgMembership(deps.api, deps.config, loaded.snapshot, () =>
    evaluate({ context: { org, repo, pr: args.prNumber }, committers, diff }, loaded.snapshot, deps.config, editions),
  );

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
  const onBehalf = (loaded.snapshot.thirdParties ?? []).find((t) => t.pr === args.prNumber && t.repo.toLowerCase() === full.toLowerCase());
  if (!hasElections && !hasGaps && !onBehalf) return { posted: false };
  await postClosingComment(deps.api, args.installationId, full, args.prNumber, closingComment(verdict, elected, onBehalf ? { name: onBehalf.name, ...(onBehalf.spdx ? { spdx: onBehalf.spdx } : {}) } : undefined, deps.config.instance.separateAgreement?.logins));
  return { posted: true };
}

type CommentContext = {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  commenter: string;
  commenterId?: number;
  prAuthor: string;
};

/** issue_comment.created - the clause-7 declaration (issues #63, #118):
 *  the committer declares the work is submitted on behalf of a named third
 *  party, under an SPDX license Ribose accepts. The declaration is
 *  recorded append-only, the PR body gains the conspicuous marking
 *  (appended only when absent), and the reply states the obligations.
 *  Coverage is unchanged: the committer's own ICLA still gates the check.
 *  The license gate is closed by default: an unconfigured list refuses
 *  every declaration, and a license off the list is refused by name. */
export async function handleThirdPartyCommand(
  deps: EnforcementDeps,
  args: CommentContext & { command: ThirdPartyParse },
): Promise<{ replied: boolean; reason?: string }> {
  const full = args.repoFullName;
  if (deps.config.coverage.reposWithoutCla.includes(full.toLowerCase())) {
    return { replied: false, reason: "repo is in repos_without_cla (out of scope by config)" };
  }
  const commenter = args.commenter.toLowerCase();
  const parsed = args.command;

  const { committers } = await fetchPrCommitters(deps.api, args.installationId, full, args.prNumber);
  const logins = new Set<string>(committers.flatMap((c) => (c.login ? [c.login.toLowerCase()] : [])));
  logins.add(args.prAuthor.toLowerCase());
  if (!logins.has(commenter)) return { replied: false, reason: "not a committer (ignored)" };

  if (parsed.kind === "malformed") {
    await postBotReply(
      deps.api,
      args.installationId,
      full,
      args.prNumber,
      `@${commenter} that declaration is not usable: ${parsed.reason}. The clause-7 command is \`@ribose-cla third-party: <name> (SPDX: <identifier>)\` — for example \`@ribose-cla third-party: Example Corp (SPDX: MIT)\`. Nothing was recorded.`,
    );
    return { replied: true, reason: `malformed third-party declaration: ${parsed.reason}` };
  }

  const gate = thirdPartyGate(deps.config.legal.thirdParty?.acceptedLicenses, parsed.spdx);
  if (!gate.allowed) {
    await postBotReply(deps.api, args.installationId, full, args.prNumber, `@${commenter} ${gate.message}`);
    return { replied: true, reason: gate.reason };
  }
  // The gate returns the CONFIGURED spelling: `mit` is recorded as `MIT`,
  // so records and renderings never vary by contributor typing.
  const spdx = gate.spdx;

  await appendRecord(
    { api: deps.api, installationId: deps.config.github.dataInstallationId, dataRepo: deps.config.github.dataRepo, now: () => Date.now() },
    "third_party",
    { id: randomToken(), repo: full, pr: args.prNumber, login: commenter, name: parsed.name, spdx, recorded_at: new Date().toISOString() },
  );

  // The conspicuous marking lives in the PR body (clause 7): append the
  // line when absent; a body that already carries it is left alone.
  const prRes = await deps.api.request(args.installationId, "GET", `/repos/${full}/pulls/${args.prNumber}`);
  if (prRes.status !== 200) throw new Error(`pull lookup failed: ${prRes.status}`);
  const prBody = (JSON.parse(prRes.body) as { body?: string }).body ?? "";
  const MARKING = `Submitted on behalf of a third-party: ${parsed.name} (SPDX: ${spdx})`;
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
      `The obligations in plain sentences: the work must not be your original creation, the source and its license (${spdx}) must be identified in the pull request, and the marking must stay conspicuous. This declaration does not replace your own agreement - your signed Individual CLA still gates this pull request.`,
      ``,
      `No Individual CLA on record? [Sign it here](${portalBase}/icla) - the declaration carries the attribution; the signature carries the coverage.`,
    ].join("\n"),
  );
  return { replied: true, reason: "third-party declaration recorded" };
}

/**
 * `@ribose-cla agree` on a PLAIN ISSUE — the signature venue's
 * "empty pull request" (GitHub has none). The record needs no PR
 * context: login + edition + time. Option B gates it — the comment is
 * the signature only where signing is fully-automatic — and every
 * PR-side guard still applies: registry logins are never asked,
 * already-signed answers idempotently. No check runs here; coverage
 * applies at the contributor's actual pull requests, and the sweep
 * refreshes any already open.
 */
export async function handleIssueAgreeCommand(
  deps: EnforcementDeps,
  args: { installationId: number; repoFullName: string; issueNumber: number; commenter: string; commenterId?: number },
): Promise<{ replied: boolean; reason: string; signed?: boolean }> {
  if (!deps.config.coverage.commentSigning.automatic) {
    return { replied: false, reason: "comment signing is not fully-automatic on this instance" };
  }
  const editions = kernelEditions(deps.config);
  const { snapshot } = await loadSnapshot(
    { listRecords: makeListRecords(deps.api, deps.config.github.dataInstallationId, deps.config.github.dataRepo) },
    editions,
  );
  const currentIcla = snapshot.iclas.find((r) => r.githubLogin.toLowerCase() === args.commenter.toLowerCase() && r.edition.textSha256 === editions.icla.textSha256);
  if (currentIcla) {
    await postBotReply(deps.api, args.installationId, args.repoFullName, args.issueNumber, `@${args.commenter} you already signed the Individual CLA v${currentIcla.edition.version} — you're covered.`);
    return { replied: true, reason: "already-signed" };
  }
  const onRegistry = (deps.config.instance.separateAgreement?.logins ?? []).some((l) => l.toLowerCase() === args.commenter.toLowerCase());
  if (onRegistry) {
    await postBotReply(deps.api, args.installationId, args.repoFullName, args.issueNumber, `@${args.commenter} — this work is submitted under an existing Ribose agreement; the CLA process does not apply to you. Nothing was recorded.`);
    return { replied: true, reason: "separate-agreement registry" };
  }
  await appendRecord(
    { api: deps.api, installationId: deps.config.github.dataInstallationId, dataRepo: deps.config.github.dataRepo, now: () => Date.now() },
    "icla",
    {
      id: await iclaRecordId(args.commenter, editions.icla.textSha256, Date.now()),
      github_login: args.commenter,
      ...(typeof args.commenterId === "number" ? { github_id: args.commenterId } : {}),
      claEdition: editions.icla,
      signed_at: new Date().toISOString(),
      past_contributions_included: true,
      source: "comment-auto",
    },
  );
  const portalBase = `https://${deps.config.instance.portalHost}`;
  await postBotReply(
    deps.api,
    args.installationId,
    args.repoFullName,
    args.issueNumber,
    [
      `@${args.commenter} — signed. The **[Individual CLA v${deps.config.legal.current.icla}](${portalBase}/agreements/text/icla/${deps.config.legal.current.icla})** is on record for you as of this comment, **including all your previous contributions**.`,
      ``,
      `_Recorded automatically from \`@ribose-cla agree\` (comment signing is fully-automatic on this instance): a GitHub-only signature record — no portal account, no identity subject. When you open a pull request in any Ribose repository, the cla/ribose check reflects it._`,
    ].join("\n"),
  );
  return { replied: true, reason: "signed automatically", signed: true };
}

/** issue_comment.created — the `@ribose-cla` command grammar
 *  (docs/design.md §3.12 + issue #57). Only PR authors/committers get
 *  a reply; everyone else is silently ignored. A comment never grants
 *  coverage by self-declaration: `icla` elects only when the kernel's
 *  live paths offer the ICLA, and `company` elects only against the
 *  org's effective Schedule A — otherwise it files a join request. */
export async function handleAgreeCommand(
  deps: EnforcementDeps,
  args: CommentContext & { command: AgreeCommand },
): Promise<{ replied: boolean; reason?: string; signed?: boolean }> {
  const full = args.repoFullName;
  if (deps.config.coverage.reposWithoutCla.includes(full.toLowerCase())) {
    return { replied: false, reason: "repo is in repos_without_cla (out of scope by config)" };
  }
  const commenter = args.commenter.toLowerCase();
  const command = args.command;

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
    const portalBase = `https://${deps.config.instance.portalHost}`;
    const currentIcla = snapshot.iclas.find((r) => r.githubLogin.toLowerCase() === commenter && r.edition.textSha256 === editions.icla.textSha256);
    if (currentIcla) {
      await postBotReply(deps.api, args.installationId, full, args.prNumber, `@${commenter} you already signed the Individual CLA v${currentIcla.edition.version} — you're covered.`);
      return { replied: true, reason: "already-signed" };
    }
    // The separate-agreement registry (issue #100): their coverage IS the
    // existing Ribose agreement, so neither flow may ask them to sign —
    // an automatic signature would record an instrument they do not need.
    const onRegistry = (deps.config.instance.separateAgreement?.logins ?? []).some((l) => l.toLowerCase() === commenter);
    if (onRegistry) {
      await postBotReply(deps.api, args.installationId, full, args.prNumber, `@${commenter} — this work is submitted under an existing Ribose agreement; the CLA process does not apply to you. Nothing was recorded.`);
      return { replied: true, reason: "separate-agreement registry" };
    }
    // Option B (issue #9, tracker #16 item 3): fully-automatic comment
    // signing, OFF unless the instance config says otherwise — counsel's
    // call. The comment IS the signature: a GitHub-only minimal record
    // lands in the data repo (no portal account, no identity subject),
    // the check re-runs on this head, and the reply states the terms the
    // thread is signing under.
    if (deps.config.coverage.commentSigning.automatic) {
      await appendRecord(
        { api: deps.api, installationId: deps.config.github.dataInstallationId, dataRepo: deps.config.github.dataRepo, now: () => Date.now() },
        "icla",
        {
          id: await iclaRecordId(commenter, editions.icla.textSha256, Date.now()),
          github_login: commenter,
          ...(typeof args.commenterId === "number" ? { github_id: args.commenterId } : {}),
          claEdition: editions.icla,
          signed_at: new Date().toISOString(),
          // The Agreement includes ALL previous contributions: the portal
          // accepts no other election, so the comment cannot elect one.
          past_contributions_included: true,
          source: "comment-auto",
        },
      );
      const autoSha = await fetchPrHeadSha(deps.api, args.installationId, full, args.prNumber);
      await evaluatePullRequest(deps, { installationId: args.installationId, repoFullName: full, prNumber: args.prNumber, headSha: autoSha });
      await postBotReply(
        deps.api,
        args.installationId,
        full,
        args.prNumber,
        [
          `@${commenter} — signed. The **[Individual CLA v${deps.config.legal.current.icla}](${portalBase}/agreements/text/icla/${deps.config.legal.current.icla})** is on record for you as of this comment, **including all your previous contributions**; the check re-ran and reflects it.`,
          ``,
          `_Recorded automatically from \`@ribose-cla agree\` (comment signing is fully-automatic on this instance): a GitHub-only signature record — no portal account, no identity subject._`,
        ].join("\n"),
      );
      return { replied: true, reason: "signed automatically", signed: true };
    }
    if (!deps.attributionSecret) return { replied: false, reason: "portal unconfigured (fail-closed)" };
    const token = await signCompletionToken(deps.attributionSecret, { repo: full, pr: args.prNumber, login: commenter }, Date.now());
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
  snapshot.msaLogins = deps.config.instance.separateAgreement?.logins ?? [];
  snapshot.msaEmails = deps.config.instance.separateAgreement?.emails ?? [];
  const verdict = await evaluateWithOrgMembership(api, deps.config, snapshot, () =>
    evaluate(
      { context: { org: full.split("/")[0] ?? "", repo: full.split("/")[1] ?? "", pr: args.prNumber }, committers: evalCommitters, ...(diff ? { diff } : {}) },
      snapshot,
      deps.config,
      editions,
    ),
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
  const ocla = oclaForSlug(snapshot.oclas, orgSlug, editions.ocla.textSha256);
  if (!ocla) {
    await postBotReply(api, args.installationId, full, args.prNumber, `@${commenter} no Organization CLA exists for "${command.company}". [See the organizations page](https://${deps.config.instance.portalHost}/organizations).`);
    return { replied: true, reason: "no such organization" };
  }
  const onRoster =
    ocla.covered.some((r) => r.githubLogin.toLowerCase() === commenter) ||
    // Coverage by GitHub-org membership (issue #16 item 4): designated
    // under this OCLA by a resolved membership fact — the same coverage
    // a named Schedule A row gives, so no join request either.
    (snapshot.orgMembers ?? []).some(
      (m) =>
        m.login.toLowerCase() === commenter &&
        (deps.config.coverage.orgMembership ?? {})[m.org.toLowerCase()]?.toLowerCase() === ocla.orgSlug.toLowerCase(),
    );
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

/** issue_comment.created — the meta grammar (2026-11-18): `help`
 *  teaches the grammar, `status` answers for the CALLER only, and
 *  `recheck` re-runs the evaluation on the current head (the manual
 *  fallback after signing elsewhere). Participant-scoped like every
 *  command: the bot answers the PR's own people, never strangers. */
export async function handleMetaCommand(
  deps: EnforcementDeps,
  args: CommentContext & { command: MetaCommand },
): Promise<{ replied: boolean; reason?: string }> {
  const full = args.repoFullName;
  if (deps.config.coverage.reposWithoutCla.includes(full.toLowerCase())) {
    return { replied: false, reason: "repo is in repos_without_cla (out of scope by config)" };
  }
  const commenter = args.commenter.toLowerCase();
  const command = args.command;

  const { committers } = await fetchPrCommitters(deps.api, args.installationId, full, args.prNumber);
  const logins = new Set<string>(committers.flatMap((c) => (c.login ? [c.login.toLowerCase()] : [])));
  logins.add(args.prAuthor.toLowerCase());
  if (!logins.has(commenter)) return { replied: false, reason: "not a committer (ignored)" };

  const portalBase = `https://${deps.config.instance.portalHost}`;
  if (command === "help") {
    await postBotReply(
      deps.api,
      args.installationId,
      full,
      args.prNumber,
      [
        `@${commenter} — everything this check supports:`,
        ``,
        `- \`@ribose-cla agree\` — sign the Individual CLA from here; the check posts your personal sign link.`,
        `- \`@ribose-cla agree icla\` — elect the Individual CLA when the check asks you to choose an agreement.`,
        `- \`@ribose-cla agree company=<org>\` — elect your organization's CLA when you are on its roster, or file a join request when you are not.`,
        `- \`@ribose-cla third-party: <name> (SPDX: <license>)\` — declare work submitted on behalf of a third party (clause 7).`,
        `- \`@ribose-cla status\` — your own coverage, answered live.`,
        `- \`@ribose-cla recheck\` — re-run the check on the current head.`,
        ``,
        `One signature covers every Ribose organization. Full guide: [How to sign the Ribose CLA](${deps.config.instance.signingDocsUrl ?? `${portalBase}/help`}) · [all commands and flows](${portalBase}/help).`,
      ].join("\n"),
    );
    return { replied: true, reason: "help posted" };
  }

  if (command === "status") {
    const editions = kernelEditions(deps.config);
    const { snapshot } = await loadSnapshot(
      { listRecords: makeListRecords(deps.api, deps.config.github.dataInstallationId, deps.config.github.dataRepo) },
      editions,
    );
    const mine = snapshot.iclas.find((r) => r.githubLogin.toLowerCase() === commenter && r.edition.textSha256 === editions.icla.textSha256);
    if (mine) {
      await postBotReply(deps.api, args.installationId, full, args.prNumber, `@${commenter} — you are covered: **Individual CLA v${mine.edition.version}**, live now. One signature covers every Ribose organization.`);
      return { replied: true, reason: "status: icla" };
    }
    const roster = snapshot.oclas.find((o) => o.edition.textSha256 === editions.ocla.textSha256 && o.covered.some((r) => r.githubLogin.toLowerCase() === commenter));
    if (roster) {
      await postBotReply(deps.api, args.installationId, full, args.prNumber, `@${commenter} — you are covered through the **${roster.orgSlug} Organization CLA** (Schedule A).`);
      return { replied: true, reason: "status: ocla" };
    }
    const registry = (deps.config.instance.separateAgreement?.logins ?? []).some((l) => l.toLowerCase() === commenter);
    if (registry) {
      await postBotReply(deps.api, args.installationId, full, args.prNumber, `@${commenter} — this work is submitted under an existing Ribose agreement; the CLA process does not apply to you.`);
      return { replied: true, reason: "status: registry" };
    }
    // Coverage by GitHub-org membership (issue #16 item 4): consulted
    // only now — the caller has no signature and no registry entry, so
    // this is the "otherwise uncovered" case the design allows.
    const orgMembership = deps.config.coverage.orgMembership;
    if (orgMembership && Object.keys(orgMembership).length > 0) {
      const facts = await resolveOrgMemberships(deps.api, orgMembership, [commenter]);
      const designated = facts
        .map((f) => orgMembership[f.org.toLowerCase()])
        .find((slug) =>
          slug &&
          snapshot.oclas.some(
            (o) =>
              o.orgSlug.toLowerCase() === slug &&
              o.edition.textSha256 === editions.ocla.textSha256 &&
              !snapshot.revokedIds.includes(o.id),
          ),
        );
      if (designated) {
        await postBotReply(deps.api, args.installationId, full, args.prNumber, `@${commenter} — you are covered through the **${designated} Organization CLA**, designated by your GitHub org membership. No signature is needed from you.`);
        return { replied: true, reason: "status: org-membership" };
      }
    }
    await postBotReply(deps.api, args.installationId, full, args.prNumber, `@${commenter} — no live agreement is on record for you. Reply \`@ribose-cla agree\` and follow the link the check posts, or [sign in the portal](${portalBase}/icla).`);
    return { replied: true, reason: "status: none" };
  }

  // recheck: re-render the public state on the current head.
  const sha = await fetchPrHeadSha(deps.api, args.installationId, full, args.prNumber);
  const r = await evaluatePullRequest(deps, { installationId: args.installationId, repoFullName: full, prNumber: args.prNumber, headSha: sha });
  await postBotReply(deps.api, args.installationId, full, args.prNumber, `@${commenter} — re-ran the check on the current head (${r.outcome}).`);
  return { replied: true, reason: "recheck run" };
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
