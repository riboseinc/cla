import { describe, expect, it } from "vitest";
import { GithubApi, type GithubApiDeps } from "../src/github/api";

/**
 * Real-crypto specs: the RSA keypair is generated per run, the JWT is
 * verified against the public key. Fetchers are fixture functions —
 * testing OUR adapter logic over canned GitHub responses (the adapter
 * is the I/O boundary; the kernel above it is exercised pure).
 */

const makeKeyPem = async (): Promise<{ privatePem: string; publicKey: CryptoKey }> => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return { privatePem: `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`, publicKey: pair.publicKey };
};

const memoryDeps = (over: Partial<GithubApiDeps> = {}): GithubApiDeps => {
  const tokens = new Map<string, string>();
  const etags = new Map<string, { etag: string; body: string }>();
  return {
    fetcher: async () => new Response("{}", { status: 500 }),
    now: () => 1_000_000_000_000,
    appId: "1234",
    privateKeyPem: "placeholder",
    tokenCache: {
      get: (k) => tokens.get(k),
      put: (k, v) => void tokens.set(k, v),
    },
    etagCache: {
      get: (k) => etags.get(k),
      put: (k, etag, body) => void etags.set(k, { etag, body }),
    },
    ...over,
  };
};

const INSTALLATIONS = {
  "/app/installations/42/access_tokens": { token: "ghs_installment_42" },
};

const fixtureFetcher = (log: { url: string; init?: RequestInit }[]) => async (url: string, init?: RequestInit): Promise<Response> => {
  log.push({ url, init });
  const path = new URL(url).pathname;
  const body = INSTALLATIONS[path as keyof typeof INSTALLATIONS];
  if (body) return new Response(JSON.stringify(body), { status: 201 });
  if (path === "/repos/o/r/git/trees/HEAD") {
    const inm = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"];
    if (inm) return new Response(null, { status: 304, headers: { etag: '"cached"' } });
    return new Response(JSON.stringify({ tree: [] }), { status: 200, headers: { etag: '"fresh"' } });
  }
  return new Response("{}", { status: 200 });
};

describe("GithubApi: app JWT", () => {
  it("mints a three-segment RS256 JWT whose payload carries iat/exp/iss and verifies against the public key", async () => {
    const { privatePem, publicKey } = await makeKeyPem();
    const api = new GithubApi(memoryDeps({ privateKeyPem: privatePem }));
    const jwt = await api.appJwt();

    const [h, p, sig] = jwt.split(".");
    expect(h).toBeDefined();
    expect(p).toBeDefined();
    expect(sig).toBeDefined();
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString()) as { iat: number; exp: number; iss: string };
    expect(payload.iss).toBe("1234");
    expect(payload.exp - payload.iat).toBe(600); // 540 + 60 back-dated drift window

    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, Buffer.from(sig!, "base64url"), new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });
});

describe("GithubApi: installation tokens", () => {
  it("mints once and caches per installation", async () => {
    const { privatePem } = await makeKeyPem();
    const calls: { url: string }[] = [];
    const api = new GithubApi(memoryDeps({ privateKeyPem: privatePem, fetcher: fixtureFetcher(calls) }));

    const t1 = await api.installationToken(42);
    const t2 = await api.installationToken(42);
    expect(t1).toBe("ghs_installment_42");
    expect(t2).toBe(t1);
    const mints = calls.filter((c) => c.url.endsWith("/access_tokens"));
    expect(mints).toHaveLength(1);
  });

  it("throws on a failed mint (fail-closed, no fake token)", async () => {
    const { privatePem } = await makeKeyPem();
    const api = new GithubApi(memoryDeps({ privateKeyPem: privatePem, fetcher: async () => new Response("{}", { status: 401 }) }));
    await expect(api.installationToken(42)).rejects.toThrow(/401/);
  });
});

describe("GithubApi: ETag-conditional requests", () => {
  it("stores the etag on 200, sends If-None-Match on the next read, and serves the cached body on 304", async () => {
    const { privatePem } = await makeKeyPem();
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = new GithubApi(memoryDeps({ privateKeyPem: privatePem, fetcher: fixtureFetcher(calls) }));

    const r1 = await api.request(42, "GET", "/repos/o/r/git/trees/HEAD", { etagPath: "tree:HEAD" });
    expect(r1.status).toBe(200);
    expect(r1.notModified).toBe(false);

    const r2 = await api.request(42, "GET", "/repos/o/r/git/trees/HEAD", { etagPath: "tree:HEAD" });
    expect(r2.notModified).toBe(true);
    expect(r2.body).toBe(r1.body);

    const treeCalls = calls.filter((c) => c.url.includes("/git/trees/"));
    const inm = ((treeCalls[1]?.init?.headers ?? {}) as Record<string, string>)["If-None-Match"];
    expect(inm).toBe('"fresh"');
  });

  it("every request carries the installation bearer token", async () => {
    const { privatePem } = await makeKeyPem();
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = new GithubApi(memoryDeps({ privateKeyPem: privatePem, fetcher: fixtureFetcher(calls) }));
    await api.request(42, "GET", "/repos/o/r/git/trees/HEAD");
    const auth = ((calls[calls.length - 1]!.init?.headers ?? {}) as Record<string, string>)["Authorization"];
    expect(auth).toBe("Bearer ghs_installment_42");
  });
});
