import { b64UrlEncode, type Fetcher } from "./oidc";

/**
 * GitHub user-identity OAuth (the App AS the identity provider): prove
 * the browser user owns a GitHub handle WITHOUT any repo scopes.
 * docs/design.md §4 — this is how every signer's handle is verified,
 * since Ribose ID tokens carry only the provider kind, never the
 * handle (research §3).
 */

export function githubAuthorizeUrl(clientId: string, redirectUri: string, state: string): URL {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url;
}

export type GithubUser = { login: string; id: number };

export async function exchangeGithubCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string | undefined,
  state: string | undefined,
  fetcher: Fetcher,
): Promise<string> {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code });
  if (redirectUri) body.set("redirect_uri", redirectUri);
  if (state) body.set("state", state);
  const res = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "ribose-cla" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the GitHub token endpoint answered ${res.status}`);
  const doc = (await res.json()) as { access_token?: string; error?: string };
  if (doc.error || typeof doc.access_token !== "string" || doc.access_token === "") {
    throw new Error(`the GitHub token endpoint granted nothing: ${doc.error ?? "no access_token"}`);
  }
  return doc.access_token;
}

export async function fetchGithubUser(userToken: string, fetcher: Fetcher): Promise<GithubUser> {
  const res = await fetcher("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${userToken}`, accept: "application/vnd.github+json", "user-agent": "ribose-cla" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the GitHub user endpoint answered ${res.status}`);
  const doc = (await res.json()) as { login?: unknown; id?: unknown };
  if (typeof doc.login !== "string" || typeof doc.id !== "number") throw new Error("the GitHub user document carried no login/id");
  return { login: doc.login, id: doc.id };
}

export function randomToken(): string {
  return b64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
