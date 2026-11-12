import { Hono } from "hono";
import { KERNEL_VERSION } from "@riboseinc/cla-kernel";
import type { Env } from "./env";
import type { FetchLike } from "./github/api";
import { GENERATED_CONFIG } from "./generated/config";
import { parseEvent, verifyWebhookSignature, installationId, repoFullName } from "./github/webhook";
import { GithubApi } from "./github/api";
import { evaluatePullRequest, preRegisterRepos, type EnforcementDeps } from "./enforcement/handler";

/**
 * The Hono app behind a thin worker entry (src/index.ts). Dependency
 * injection keeps every leg drivable from vitest via app.fetch with
 * no doubles (docs/design.md §10).
 */
export function createApp(env: Env, overrides?: { fetcher?: FetchLike }) {
  const app = new Hono<{ Bindings: Env }>();

  // Status-service probe target: content-assertable, cheap, honest.
  app.get("/healthz", (c) =>
    c.json({ service: "ribose-cla", status: "ok", kernel: KERNEL_VERSION, instance: GENERATED_CONFIG.instance.name }),
  );

  // ---- GitHub webhook (fail-closed: no secret configured -> closed) ----
  const webhookSecret = env.WEBHOOK_SECRET;
  if (webhookSecret) {
    app.post("/api/github/webhook", async (c) => {
      const raw = await c.req.text();
      const sig = c.req.header("x-hub-signature-256");
      if (!(await verifyWebhookSignature(raw, sig, webhookSecret))) {
        return c.json({ error: "invalid signature" }, 401);
      }
      const evt = parseEvent(c.req.header("x-github-event"), raw);
      if (!evt) return c.json({ error: "unparseable payload" }, 400);

      const api = new GithubApi({
        fetcher: overrides?.fetcher ?? fetch,
        now: () => Date.now(),
        appId: env.GITHUB_APP_ID ?? "",
        privateKeyPem: (env.APP_PRIVATE_KEY ?? "").replaceAll("\\n", "\n"),
        tokenCache: TOKEN_CACHE,
        etagCache: ETAG_CACHE,
      });
      const deps: EnforcementDeps = { api, config: GENERATED_CONFIG, staff: {} };

      try {
        if (evt.event === "pull_request" && ["opened", "synchronize", "reopened"].includes(evt.action ?? "")) {
          const pr = evt.payload["pull_request"] as Record<string, unknown> | undefined;
          const head = pr?.["head"] as Record<string, unknown> | undefined;
          const number = evt.payload["number"];
          const repo = repoFullName(evt.payload);
          const inst = installationId(evt.payload);
          const sha = typeof head?.["sha"] === "string" ? head["sha"] : undefined;
          if (!pr || !repo || !inst || !sha || typeof number !== "number") {
            return c.json({ error: "payload missing expected fields" }, 400);
          }
          const r = await evaluatePullRequest(deps, { installationId: inst, repoFullName: repo, prNumber: number, headSha: sha });
          return c.json({ ok: true, outcome: r.outcome });
        }
        if ((evt.event === "installation_repositories" && evt.action === "added") || (evt.event === "installation" && evt.action === "created")) {
          const inst = installationId(evt.payload);
          if (!inst) return c.json({ error: "payload missing installation id" }, 400);
          const repos =
            evt.event === "installation"
              ? reposFromInstallation(evt.payload)
              : (evt.payload["repositories_added"] as Array<Record<string, unknown>> | undefined)?.map((r) => r["full_name"] as string).filter(Boolean) ?? [];
          const done = await preRegisterRepos(deps, inst, repos);
          return c.json({ ok: true, preregistered: done });
        }
        return c.json({ ok: true, ignored: `${evt.event}/${evt.action ?? "*"}` });
      } catch (e) {
        // Fail-closed honesty: enforcement failures are returned as the
        // error they are — GitHub will redeliver; we never fake a pass.
        return c.json({ error: `enforcement failed: ${(e as Error).message}` }, 503);
      }
    });
  }

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}

function reposFromInstallation(payload: Record<string, unknown>): string[] {
  const repos = payload["repositories"];
  return Array.isArray(repos) ? repos.map((r) => (r as Record<string, unknown>)["full_name"] as string).filter(Boolean) : [];
}

// The instance/KV-backed caches land with the instance repo (#12 owner
// half); until then these are per-isolate memory caches (created once,
// shared across requests in the isolate).
const TOKEN_CACHE = memoryCache();
const ETAG_CACHE = memoryEtagCache();

function memoryCache(): { get: (k: string) => string | undefined; put: (k: string, v: string, ttl: number) => void } {
  const m = new Map<string, { v: string; until: number }>();
  return {
    get: (k) => {
      const hit = m.get(k);
      if (hit && hit.until > Date.now()) return hit.v;
      return undefined;
    },
    put: (k, v, ttl) => m.set(k, { v, until: Date.now() + ttl * 1000 }),
  };
}
function memoryEtagCache(): { get: (k: string) => { etag: string; body: string } | undefined; put: (k: string, etag: string, body: string) => void } {
  const m = new Map<string, { etag: string; body: string }>();
  return { get: (k) => m.get(k), put: (k, etag, body) => m.set(k, { etag, body }) };
}
