/**
 * Per-isolate caches (token + etag). The instance deploy swaps these
 * for KV-backed adapters; the isolate memory versions are correct for
 * single-isolate lifetimes and for specs.
 */
export const TOKEN_CACHE = (() => {
  const m = new Map<string, { v: string; until: number }>();
  return {
    get: (k: string) => {
      const hit = m.get(k);
      if (hit && hit.until > Date.now()) return hit.v;
      return undefined;
    },
    put: (k: string, v: string, ttl: number) => m.set(k, { v, until: Date.now() + ttl * 1000 }),
  };
})();

export const ETAG_CACHE = (() => {
  const m = new Map<string, { etag: string; body: string }>();
  return {
    get: (k: string) => m.get(k),
    put: (k: string, etag: string, body: string) => m.set(k, { etag, body }),
  };
})();
