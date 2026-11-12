import type { GithubApi } from "../github/api";
import type { PrVerdict } from "@riboseinc/cla-kernel";

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

export function checkRunBody(verdict: PrVerdict, portalBase: string): Record<string, unknown> {
  const lines: string[] = [];
  for (const c of verdict.committers) {
    if (c.status === "covered") {
      lines.push(`- @${c.login ?? "(unlinked)"} — covered via **${c.path}**${c.agreement && "orgSlug" in c.agreement ? ` (${c.agreement.orgSlug} OCLA)` : ""}`);
    } else if (c.status === "must-specify") {
      const links = c.options.map((o) => (o.kind === "icla" ? "[Individual CLA]" : o.kind === "staff" ? `[staff (${o.org})]` : `[${o.orgSlug} OCLA]`)).join(" ");
      lines.push(`- @${c.login ?? "(unlinked)"} — covered by multiple agreements; **specify under which one this PR is contributed**: ${links}`);
    } else {
      lines.push(`- @${c.login ?? "(unlinked)"} — **not covered**: [sign the Individual CLA](${portalBase}/icla) or [join your organization's OCLA](${portalBase}/organizations)`);
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

export function commentBody(verdict: PrVerdict, portalBase: string, notices: string[] = []): string {
  const rows: string[] = [];
  for (const c of verdict.committers) {
    if (c.status === "covered") {
      rows.push(`| @${c.login ?? "(unlinked)"} | covered (${c.path}${c.agreement && "orgSlug" in c.agreement ? ` — ${c.agreement.orgSlug}` : ""}) |`);
    } else if (c.status === "must-specify") {
      rows.push(`| @${c.login ?? "(unlinked)"} | **specify the agreement** — ${c.options.map((o) => (o.kind === "icla" ? "Individual CLA" : o.kind === "staff" ? `staff (${o.org})` : `${o.orgSlug} OCLA`)).join(", ")} |`);
    } else {
      rows.push(`| @${c.login ?? "(unlinked)"} | **missing** — [sign the ICLA](${portalBase}/icla) or [find your organization](${portalBase}/organizations) |`);
    }
  }
  return [
    COMMENT_MARKER,
    `**${CHECK_NAME}** — ${verdict.verdict === "fail" ? "merge blocked: a committer is not covered" : Object.keys(verdict.mustSpecify).length > 0 ? "action needed: specify under which agreement" : "all committers covered"}`,
    "",
    "| Committer | Status |",
    "|---|---|",
    ...rows,
    ...(notices.length > 0 ? ["", ...notices] : []),
  ].join("\n");
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
 * Pre-registration (docs/design.md §3.13): on installation/repo-added,
 * post a NEUTRAL `cla/ribose` run on the default branch HEAD so the
 * check name is requirable in branch protection immediately.
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
  await createCheckRun(api, installationId, repoFullName, sha, {
    name: CHECK_NAME,
    status: "completed",
    conclusion: "neutral",
    output: { title: `CLA (${CHECK_NAME})`, summary: "Check pre-registered; evaluates pull requests." },
  });
}
