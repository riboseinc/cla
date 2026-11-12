import type { StaffMap } from "@riboseinc/cla-kernel";
import { evaluate } from "@riboseinc/cla-kernel";
import type { AppConfig } from "../config";
import { kernelEditions } from "../config";
import { loadSnapshot } from "../store/load";
import { fetchPrCommitters } from "../github/pulls";
import type { GithubApi } from "../github/api";
import { makeListRecords } from "../store/github-store";
import { checkRunBody, createCheckRun, commentBody, upsertComment, preRegisterCheck, CHECK_NAME } from "./checks";

/**
 * The pull_request orchestration (docs/design.md §5). Every store or
 * GitHub failure propagates: the route maps it to an honest FAILING
 * check — fail-closed, never a silent pass.
 */

export type EnforcementDeps = {
  api: GithubApi;
  config: AppConfig;
  /** staff resolution lands in issue #10; empty until then (fail-closed). */
  staff: StaffMap;
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
  const { snapshot } = await loadSnapshot(
    { listRecords: makeListRecords(deps.api, deps.config.github.dataInstallationId, deps.config.github.dataRepo) },
    editions,
  );
  const verdict = evaluate({ context: { org, repo }, committers }, snapshot, deps.config, editions, deps.staff);

  const portalBase = `https://${deps.config.instance.portalHost}`;
  await createCheckRun(deps.api, args.installationId, full, args.headSha, checkRunBody(verdict, portalBase));
  await upsertComment(deps.api, args.installationId, full, args.prNumber, commentBody(verdict, portalBase));
  return { handled: true, outcome: `verdict=${verdict.verdict} missing=${verdict.missing.length} specify=${Object.keys(verdict.mustSpecify).length}` };
}

/** installation_repositories.added / installation.created — pre-register the check name per repo. */
export async function preRegisterRepos(deps: EnforcementDeps, installationId: number, repos: string[]): Promise<string[]> {
  const done: string[] = [];
  for (const repo of repos) {
    if (deps.config.coverage.reposWithoutCla.includes(repo.toLowerCase())) continue;
    await preRegisterCheck(deps.api, installationId, repo);
    done.push(repo);
  }
  return done;
}
