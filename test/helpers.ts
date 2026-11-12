import type { FetchLike } from "../src/github/api";
import { GENERATED_CONFIG } from "../src/generated/config";

/** Shared spec helpers: a real RSA PEM + a routeable GitHub fixture. */

export const WEBHOOK_SECRET = "It's a Secret to Everybody";

/** The example instance's CURRENT editions — fixtures must pin these or the kernel reads them stale. */
export const CURRENT_EDITIONS = {
  icla: GENERATED_CONFIG.legal.editions.icla.find((e) => e.version === GENERATED_CONFIG.legal.current.icla)!,
  ocla: GENERATED_CONFIG.legal.editions.ocla.find((e) => e.version === GENERATED_CONFIG.legal.current.ocla)!,
};

export async function makeKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

export async function hmacHex(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Fixture = {
  fetcher: FetchLike;
  calls: { method: string; url: string; body?: unknown; init?: RequestInit }[];
  /** override specific routes in a test */
  routes: Map<string, (url: URL, init?: RequestInit) => Response | undefined>;
};

const INSTALLATIONS: Record<string, unknown> = {
  "/app/installations/42/access_tokens": { token: "ghs_42" },
  "/app/installations/7/access_tokens": { token: "ghs_7" },
  // the example config's data installation (the data-repo org's install)
  "/app/installations/1/access_tokens": { token: "ghs_data_1" },
};

const DATA_OCLA = () => ({
  id: "ocla-mtg",
  orgSlug: "mtg-ag",
  claEdition: { kind: "ocla", version: CURRENT_EDITIONS.ocla.version, textSha256: CURRENT_EDITIONS.ocla.sha256 },
  covered: [{ githubLogin: "tj-91", email: "johannes@mtg.example" }, { githubLogin: "falko-strenzke", email: "falko@mtg.example" }],
  signatory: { name: "S", email: "s@mtg.example" },
  poc: { name: "P", email: "p@mtg.example" },
  domains: ["mtg.example"],
  pastContributionsIncluded: true,
  source: "backfill",
});

export function makeFixture(): Fixture {
  const calls: Fixture["calls"] = [];
  const routes = new Map<string, (url: URL, init?: RequestInit) => Response | undefined>();
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", etag: '"w"', ...headers } });

  const fetcher: FetchLike = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init?.method ?? "GET", url: url.toString(), body: init?.body ? JSON.parse(init.body as string) : undefined, init });

    const override = routes.get(u.pathname);
    if (override) {
      const r = override(u, init);
      if (r) return r;
    }
    const inst = INSTALLATIONS[u.pathname];
    if (inst !== undefined) return new Response(JSON.stringify(inst), { status: 201 });

    if (u.pathname === "/repos/rnpgp/rnp/pulls/1/commits") {
      return json(200, [
        { sha: "a", author: { login: "tj-91", type: "User" }, commit: { author: { email: "johannes@mtg.example" } } },
        { sha: "b", author: { login: "stranger", type: "User" }, commit: { author: { email: "s@x.example" } } },
        { sha: "c", author: { login: "dependabot[bot]", type: "Bot" }, commit: { author: { email: "bot@x.example" } } },
      ]);
    }
    if (u.pathname === "/repos/example-org/cla-data/git/trees/HEAD") {
      return json(200, { tree: [{ path: "ocla/2026/03/mtg.json", type: "blob" }, { path: "README.md", type: "blob" }] });
    }
    if (u.pathname === "/repos/example-org/cla-data/contents/ocla/2026/03/mtg.json") {
      return json(200, { content: Buffer.from(JSON.stringify(DATA_OCLA())).toString("base64"), encoding: "base64" });
    }
    // write-endpoint defaults (tests assert on captured calls)
    if (u.pathname.endsWith("/check-runs") && init?.method === "POST") return json(201, {});
    if (/\/issues\/\d+\/comments$/.test(u.pathname) && init?.method === "POST") return json(201, {});
    if (/\/issues\/\d+\/comments$/.test(u.pathname)) return json(200, []);
    if (/\/issues\/comments\/\d+$/.test(u.pathname) && init?.method === "PATCH") return json(200, {});
    return json(404, { message: "fixture has no route for " + u.pathname });
  };

  return { fetcher, calls, routes };
}

export function pullRequestPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "opened",
    number: 1,
    installation: { id: 42 },
    repository: { full_name: "rnpgp/rnp" },
    pull_request: { head: { sha: "abc123" } },
    ...over,
  };
}

export async function signedBody(secret: string, payload: unknown): Promise<{ body: string; headers: Record<string, string> }> {
  const body = JSON.stringify(payload);
  const sig = await hmacHex(secret, body);
  return { body, headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${sig}` } };
}
