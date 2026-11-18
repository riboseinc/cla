import type { Env } from "../env";
import type { FetchLike } from "../github/api";
import { GithubApi } from "../github/api";
import { GENERATED_CONFIG } from "../generated/config";
import { editionText, kernelEditions } from "../config";
import { readSessionCookie, SESSION_COOKIE, CSRF_COOKIE } from "./session";
import { loadSnapshot } from "../store/load";
import { makeListRecords } from "../store/github-store";
import { TOKEN_CACHE, ETAG_CACHE } from "../cache";

/**
 * Portal helpers shared by the signing + agreements surfaces: session
 * reads, CSRF double-submit, and the signer's view of the data repo.
 */

export function readCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(";").find((x) => x.trim().startsWith(`${name}=`))?.split("=").slice(1).join("=");
}

export function portalApi(env: Env, fetcher: FetchLike, now: () => number): GithubApi {
  return new GithubApi({
    fetcher,
    now,
    appId: env.GITHUB_APP_ID ?? "",
    privateKeyPem: (env.APP_PRIVATE_KEY ?? "").replaceAll("\\n", "\n"),
    tokenCache: TOKEN_CACHE,
    etagCache: ETAG_CACHE,
  });
}

export const sessionOf = (env: Env, header: string | undefined, now: number) =>
  readSessionCookie(env.OIDC_CLIENT_SECRET!, readCookie(header, SESSION_COOKIE), now);

/** CSRF double-submit: the cookie token must equal the form field. */
export function csrfOk(header: string | undefined, formField: string | undefined): boolean {
  const cookie = readCookie(header, CSRF_COOKIE);
  return cookie !== undefined && formField !== undefined && cookie === formField;
}

/** Everything the signed-in person is party to (docs/design.md §4, "My agreements"). */
export async function signerView(env: Env, fetcher: FetchLike, now: () => number, login: string) {
  const editions = kernelEditions(GENERATED_CONFIG);
  const { snapshot, rejected, emails } = await loadSnapshot(
    { listRecords: makeListRecords(portalApi(env, fetcher, now), GENERATED_CONFIG.github.dataInstallationId, GENERATED_CONFIG.github.dataRepo) },
    editions,
  );
  const l = login.toLowerCase();
  return {
    iclaSignatures: snapshot.iclas
      .filter((r) => r.githubLogin.toLowerCase() === l)
      .map((r) => ({ edition: r.edition, current: r.edition.textSha256 === editions.icla.textSha256, email: r.email ?? null })),
    oclaCoverages: snapshot.oclas
      .filter((o) => o.covered.some((row) => row.githubLogin.toLowerCase() === l))
      .map((o) => ({
        org: o.orgSlug,
        edition: o.edition,
        current: o.edition.textSha256 === editions.ocla.textSha256,
        row: o.covered.find((row) => row.githubLogin.toLowerCase() === l),
      })),
    // Addresses this login proved through the mail loop (issue #115):
    // commits carrying them count as this login's, whatever machine
    // produced them.
    commitEmails: emails
      .filter((e) => e.githubLogin.toLowerCase() === l)
      .map((e) => ({ email: e.email, verifiedAt: e.verifiedAt })),
    attributions: (snapshot.attributions ?? []).filter((a) => a.login.toLowerCase() === l),
    rejectedCount: rejected.length,
    // A login the separate-agreement registry binds is covered outright
    // (issue #100): the portal must never ask them to sign, so the view
    // says so instead of showing the sign-up prompt.
    separateAgreement: (GENERATED_CONFIG.instance.separateAgreement?.logins ?? []).some((x) => x.toLowerCase() === l),
  };
}

export { editionText, GENERATED_CONFIG };
