/**
 * GitHub REST access for the App: app-level JWT -> installation tokens
 * (cached, ~55 min TTL) -> API calls with ETag-aware conditional
 * requests. The fetcher and clock are injected so specs drive this
 * against fixture responses (docs/design.md §5; the token mechanics
 * were verified against current docs at design time).
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type GithubApiDeps = {
  /** fetch, injectable for specs */
  fetcher: FetchLike;
  /** clock, injectable for specs */
  now: () => number;
  appId: string;
  privateKeyPem: string;
  /** short-lived token cache backing (KV/D1 adapter in the instance; map in specs) */
  tokenCache: { get: (key: string) => string | undefined; put: (key: string, value: string, ttlSeconds: number) => void };
  /** snapshot cache backing keyed by etag-able path */
  etagCache: { get: (key: string) => { etag: string; body: string } | undefined; put: (key: string, etag: string, body: string) => void };
};

const TOKEN_TTL_SECONDS = 55 * 60; // installation tokens live 1h; re-mint early

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = Buffer.from(
    pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, ""),
    "base64",
  );
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export class GithubApi {
  private readonly deps: GithubApiDeps;
  private keyPromise?: Promise<CryptoKey>;

  constructor(deps: GithubApiDeps) {
    this.deps = deps;
  }

  /** RS256 app JWT (iat back-dated 60s for drift, exp 10 min). */
  async appJwt(): Promise<string> {
    const key = await (this.keyPromise ??= importPrivateKey(this.deps.privateKeyPem));
    const now = Math.floor(this.deps.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = { iat: now - 60, exp: now + 540, iss: this.deps.appId };
    const input = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  }

  /** Installation token, cached ~55 min per installation id. */
  async installationToken(installationId: number): Promise<string> {
    const key = `inst-token:${installationId}`;
    const cached = this.deps.tokenCache.get(key);
    if (cached) return cached;

    const res = await this.deps.fetcher(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.appJwt()}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`installation token mint failed: ${res.status}`);
    const body = (await res.json()) as { token: string };
    this.deps.tokenCache.put(key, body.token, TOKEN_TTL_SECONDS);
    return body.token;
  }

  /**
   * An authenticated request. `etagPath`, when given, makes this a
   * conditional request: cache hit + 304 returns the cached body and
   * flags `notModified` (conditional requests don't count against the
   * primary rate limit).
   */
  async request(
    installationId: number,
    method: string,
    path: string,
    opts: { body?: unknown; etagPath?: string } = {},
  ): Promise<{ status: number; body: string; notModified: boolean }> {
    const token = await this.installationToken(installationId);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (opts.etagPath) {
      const cached = this.deps.etagCache.get(opts.etagPath);
      if (cached) headers["If-None-Match"] = cached.etag;
    }
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.deps.fetcher(`https://api.github.com${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    if (opts.etagPath && res.status === 304) {
      const cached = this.deps.etagCache.get(opts.etagPath)!;
      return { status: 200, body: cached.body, notModified: true };
    }
    const body = await res.text();
    if (opts.etagPath && res.ok) {
      const etag = res.headers.get("etag");
      if (etag) this.deps.etagCache.put(opts.etagPath, etag, body);
    }
    return { status: res.status, body, notModified: false };
  }
}
