import type { GithubApi } from "../github/api";
import type { AgreementRef, PrVerdict } from "@riboseinc/cla-kernel";

/**
 * Check-run + comment mechanics for the `cla/ribose` check
 * (docs/design.md §5). Conclusions: pass → success; missing → failure;
 * must-specify → action_required. One threaded comment per PR, updated
 * in place (marker-matched), never comment-spamming.
 */

export const CHECK_NAME = "cla/ribose";
export const COMMENT_MARKER = "<!-- ribose-cla:comment -->";

export function conclusionFor(verdict: PrVerdict): "success" | "failure" | "action_required" {
  if (verdict.verdict === "fail") return "failure";
  return Object.keys(verdict.mustSpecify).length > 0 ? "action_required" : "success";
}

export function checkRunBody(verdict: PrVerdict, portalBase: string, signingDocsUrl?: string): Record<string, unknown> {
  // The proportionality control fired: the honest, visible disclosure —
  // the check passes because the change is under the thresholds, never
  // silently (issue #58).
  if (verdict.minimalChange === true) {
    return {
      name: CHECK_NAME,
      status: "completed",
      conclusion: "success",
      output: {
        title: `CLA (${CHECK_NAME})`,
        summary: "The change is under the minimal-change threshold, so the CLA was not enforced for this pull request. A larger change requires a signature.",
      },
    };
  }
  const lines: string[] = [];
  for (const c of verdict.committers) {
    if (c.status === "covered") {
      const via = c.underSeparateAgreement
        ? "**an existing Ribose agreement**"
        : `**${c.path}**${c.agreement && "orgSlug" in c.agreement ? ` (${c.agreement.orgSlug} OCLA)` : ""}`;
      lines.push(`- @${c.login ?? "(unlinked)"} — covered via ${via}`);
    } else if (c.status === "must-specify") {
      const links = c.options.map((o) => (o.kind === "icla" ? "[Individual CLA]" : `[${o.orgSlug} OCLA]`)).join(" ");
      lines.push(`- @${c.login ?? "(unlinked)"} — covered by multiple agreements; **specify under which one this PR is contributed**: ${links}`);
    } else {
      lines.push(`- @${c.login ?? "(unlinked)"} — **not covered**: [sign the Individual CLA](${portalBase}/icla)${signingDocsUrl ? ` ([how to sign](${signingDocsUrl}))` : ""} or [join your organization's OCLA](${portalBase}/organizations)`);
    }
  }
  const summary = lines.length > 0 ? lines.join("\n") : "No human committers to evaluate.";
  return {
    name: CHECK_NAME,
    status: "completed",
    conclusion: conclusionFor(verdict),
    output: { title: `CLA (${CHECK_NAME})`, summary },
  };
}

export async function createCheckRun(
  api: GithubApi,
  installationId: number,
  repoFullName: string,
  headSha: string,
  body: Record<string, unknown>,
): Promise<void> {
  const payload = { ...body, head_sha: headSha };
  const res = await api.request(installationId, "POST", `/repos/${repoFullName}/check-runs`, { body: payload });
  if (res.status !== 201) throw new Error(`check run creation failed: ${res.status}`);
}

// ---- comments ----

export function commentBody(
  verdict: PrVerdict,
  portalBase: string,
  opts: {
    notices?: string[];
    attributionLinks?: Record<string, Array<{ label: string; url: string }>>;
    signingDocsUrl?: string;
    /** login -> the editions at play when the signer holds a stale signature */
    staleEditions?: Record<string, { signed: string; current: string }>;
  } = {},
): string {
  const rows: string[] = [];
  for (const c of verdict.committers) {
    if (c.status === "covered") {
      // Allowlist rows stay in the check summary; the conversation
      // comment omits them — they are noise for humans.
      if (c.path === "allowlist") continue;
      rows.push(c.underSeparateAgreement
        ? `| @${c.login ?? "(unlinked)"} | this work is submitted under an existing Ribose agreement; the CLA process does not apply. |`
        : `| @${c.login ?? "(unlinked)"} | covered (${c.path}${c.agreement && "orgSlug" in c.agreement ? ` — ${c.agreement.orgSlug}` : ""}) |`);
    } else if (c.status === "must-specify") {
      const links = (opts.attributionLinks?.[c.login ?? ""] ?? c.options.map((o) => ({ label: o.kind === "icla" ? `Individual CLA v${o.version}` : `${o.orgSlug} OCLA v${o.version}`, url: `${portalBase}/agreements` })))
        .map((l) => `[${l.label}](${l.url})`)
        .join(" · ");
      rows.push(`| @${c.login ?? "(unlinked)"} | This pull request is covered by more than one agreement. Choose the one that applies: ${links}. |`);
    } else {
      const stale = c.login ? opts.staleEditions?.[c.login] : undefined;
      const what = stale
        ? `You signed the Individual CLA v${stale.signed}, and the current edition is v${stale.current}; the text changed, so a re-sign is needed`
        : "Ribose requires a signed agreement for every contribution";
      rows.push(`| @${c.login ?? "(unlinked)"} | ${what}. [Sign the Individual CLA](${portalBase}/icla)${opts.signingDocsUrl ? ` ([how to sign](${opts.signingDocsUrl}))` : ""} or [find your organization](${portalBase}/organizations). |`);
    }
  }
  const headline =
    verdict.verdict === "fail"
      ? "merge blocked: the pull request includes a contribution from a committer without a signed agreement"
      : Object.keys(verdict.mustSpecify).length > 0
        ? "action needed: the coverage of this pull request is ambiguous, and the contributor chooses the agreement that applies"
        : "all committers covered";
  return [
    COMMENT_MARKER,
    `**${CHECK_NAME}** — ${headline}.`,
    "",
    "| Committer | Status |",
    "|---|---|",
    ...rows,
    ...(opts.notices?.length ? ["", ...opts.notices] : []),
    ...(opts.signingDocsUrl ? ["", `New to this check? [How to sign the Ribose CLA](${opts.signingDocsUrl}) explains both flows; one signature covers every Ribose organization. Once the signature is recorded, this check turns green on its own, and no re-push is needed.`] : []),
  ].join("\n");
}

/** The closing statement on merge — the public attribution record (docs/design.md §3.11). */
export const CLOSING_MARKER = "<!-- ribose-cla:closing -->";

export function closingComment(verdict: PrVerdict, elected: Record<string, AgreementRef>, onBehalf?: string): string {
  // The proportionality disclosure: the merged contribution landed
  // without CLA coverage because the change was under the thresholds
  // (issue #58) — attribution honesty, never silence.
  if (verdict.minimalChange === true) {
    return [
      CLOSING_MARKER,
      "**CLA attribution for this merged contribution**",
      "- The change was under the minimal-change threshold, so the CLA was not enforced. The contribution is attributed to its committers as visible in history.",
    ].join("\n");
  }
  const lines = Object.keys(elected).length > 0 ? ["", "Elections recorded during review:"] : [];
  for (const [login, a] of Object.entries(elected)) {
    lines.push(`- @${login} — under ${a.kind === "icla" ? `the Individual CLA v${a.version}` : `the ${a.orgSlug} OCLA v${a.version}`}`);
  }
  const rows = verdict.committers.map((c) => {
    if (c.status === "covered") {
      // The separate-agreement sentence carries its own shape: it reads
      // as a sentence, not as a "contributed under X" fragment.
      if (c.underSeparateAgreement) {
        return `- @${c.login ?? "(unlinked)"} — this work is submitted under an existing Ribose agreement; the CLA process does not apply.`;
      }
      const under =
        c.path === "allowlist"
          ? "configuration allowlist"
          : c.agreement && "orgSlug" in c.agreement
            ? `the ${c.agreement.orgSlug} OCLA v${c.agreement.version}`
            : `the Individual CLA v${(c.agreement as { version: string }).version}`;
      return `- @${c.login ?? "(unlinked)"} — contributed under **${under}**`;
    }
    if (c.status === "must-specify") return `- @${c.login ?? "(unlinked)"} — contributed under an election recorded during review`;
    return `- @${c.login ?? "(unlinked)"} — **merged without CLA coverage** (visible in history)`;
  });
  const behalf = onBehalf ? ["", `- Contributed on behalf of a third party: **${onBehalf}** (declared under the Agreement's third-party clause)`] : [];
  return [CLOSING_MARKER, "**CLA attribution for this merged contribution**", ...rows, ...lines, ...behalf].join("\n");
}

export async function postClosingComment(api: GithubApi, installationId: number, repoFullName: string, prNumber: number, body: string): Promise<void> {
  const list = await api.request(installationId, "GET", `/repos/${repoFullName}/issues/${prNumber}/comments?per_page=100`);
  if (list.status !== 200) throw new Error(`comment listing failed: ${list.status}`);
  const comments = JSON.parse(list.body) as Array<{ id: number; body?: string }>;
  if (comments.some((c) => typeof c.body === "string" && c.body.includes(CLOSING_MARKER))) return; // dedupe redeliveries
  const res = await api.request(installationId, "POST", `/repos/${repoFullName}/issues/${prNumber}/comments`, { body: { body } });
  if (res.status !== 201) throw new Error(`closing comment failed: ${res.status}`);
}

export async function upsertComment(
  api: GithubApi,
  installationId: number,
  repoFullName: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const list = await api.request(installationId, "GET", `/repos/${repoFullName}/issues/${prNumber}/comments?per_page=100`);
  if (list.status !== 200) throw new Error(`comment listing failed: ${list.status}`);
  const comments = JSON.parse(list.body) as Array<{ id: number; body?: string; user?: { login?: string } }>;
  const ours = comments.find((c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER) && c.user?.login?.endsWith("[bot]"));
  if (ours) {
    const res = await api.request(installationId, "PATCH", `/repos/${repoFullName}/issues/comments/${ours.id}`, { body: { body } });
    if (res.status !== 200) throw new Error(`comment update failed: ${res.status}`);
  } else {
    const res = await api.request(installationId, "POST", `/repos/${repoFullName}/issues/${prNumber}/comments`, { body: { body } });
    if (res.status !== 201) throw new Error(`comment creation failed: ${res.status}`);
  }
}

/**
 * Silence when covered (the cla-assistant contract): the conversation
 * comment exists to prompt action. When the verdict needs no action,
 * the green check run is the record — and a comment left over from an
 * earlier state is retracted, not edited into a table that re-mentions
 * already-covered committers on every evaluation.
 */
export async function retractCoverageComment(
  api: GithubApi,
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Promise<boolean> {
  const list = await api.request(installationId, "GET", `/repos/${repoFullName}/issues/${prNumber}/comments?per_page=100`);
  if (list.status !== 200) throw new Error(`comment listing failed: ${list.status}`);
  const comments = JSON.parse(list.body) as Array<{ id: number; body?: string; user?: { login?: string } }>;
  const ours = comments.find((c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER) && c.user?.login?.endsWith("[bot]"));
  if (!ours) return false;
  const res = await api.request(installationId, "DELETE", `/repos/${repoFullName}/issues/comments/${ours.id}`);
  if (res.status !== 204) throw new Error(`comment retraction failed: ${res.status}`);
  return true;
}

/**
 * Pre-registration (docs/design.md §3.13): on installation/repo-added,
 * post a NEUTRAL `cla/ribose` run on the default branch HEAD so the
 * check name is requirable in branch protection immediately.
 *
 * Idempotent: a resumed backfill (or a redelivered webhook) must not
 * stack duplicate neutral runs on the same commit, so an existing run
 * named `cla/ribose` short-circuits. A failed probe is not fatal — the
 * create below is the point, and would surface the same error.
 */
export async function preRegisterCheck(api: GithubApi, installationId: number, repoFullName: string): Promise<void> {
  const info = await api.request(installationId, "GET", `/repos/${repoFullName}`);
  if (info.status !== 200) throw new Error(`repo info failed: ${info.status}`);
  const def = (JSON.parse(info.body) as { default_branch?: string }).default_branch;
  if (!def) throw new Error("repo has no default branch");
  const head = await api.request(installationId, "GET", `/repos/${repoFullName}/commits/${encodeURIComponent(def)}`);
  if (head.status !== 200) throw new Error(`head commit lookup failed: ${head.status}`);
  const sha = (JSON.parse(head.body) as { sha?: string }).sha;
  if (!sha) throw new Error("head commit has no sha");
  const existing = await api.request(
    installationId,
    "GET",
    `/repos/${repoFullName}/commits/${encodeURIComponent(def)}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}`,
  );
  if (existing.status === 200) {
    const runs = (JSON.parse(existing.body) as { check_runs?: unknown[] }).check_runs;
    if (Array.isArray(runs) && runs.length > 0) return;
  }
  await createCheckRun(api, installationId, repoFullName, sha, {
    name: CHECK_NAME,
    status: "completed",
    conclusion: "neutral",
    output: { title: `CLA (${CHECK_NAME})`, summary: "Check pre-registered; evaluates pull requests." },
  });
}
