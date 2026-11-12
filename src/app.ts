import { Hono } from "hono";
import { KERNEL_VERSION } from "@riboseinc/cla-kernel";
import type { Env } from "./env";
import type { FetchLike } from "./github/api";
import { GENERATED_CONFIG } from "./generated/config";
import { parseEvent, verifyWebhookSignature, installationId, repoFullName } from "./github/webhook";
import { GithubApi } from "./github/api";
import { evaluatePullRequest, closeMergedPullRequest, preRegisterRepos, type EnforcementDeps } from "./enforcement/handler";
import { discover, authorizationRequest, exchangeCode, verifyIdToken, resetOidcCaches } from "./portal/oidc";
import { githubAuthorizeUrl, exchangeGithubCode, fetchGithubUser, randomToken } from "./portal/github-oauth";
import { SESSION_COOKIE, CSRF_COOKIE, makeSessionCookie, readSessionCookie, makeStateCookie, readStateCookie, newCsrfToken } from "./portal/session";
import { readAttributionToken, optionKey } from "./portal/attribution";
import { fetchPrHeadSha } from "./github/pulls";
import { appendRecord } from "./store/write";
import { readCookie, sessionOf, csrfOk, signerView, editionText, portalApi } from "./portal/helpers";
import { TOKEN_CACHE, ETAG_CACHE } from "./cache";

/**
 * The Hono app behind a thin worker entry (src/index.ts). Dependency
 * injection keeps every leg drivable from vitest via app.fetch with
 * no doubles (docs/design.md §10).
 */
export function createApp(env: Env, overrides?: { fetcher?: FetchLike; now?: () => number }) {
  const now = overrides?.now ?? (() => Date.now());
  const fetcher = overrides?.fetcher ?? fetch;
  const identity = GENERATED_CONFIG.identity;
  const portalBase = `https://${GENERATED_CONFIG.instance.portalHost}`;
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
        fetcher,
        now,
        appId: env.GITHUB_APP_ID ?? "",
        privateKeyPem: (env.APP_PRIVATE_KEY ?? "").replaceAll("\\n", "\n"),
        tokenCache: TOKEN_CACHE,
        etagCache: ETAG_CACHE,
      });
      const deps: EnforcementDeps = { api, config: GENERATED_CONFIG, staff: {}, attributionSecret: env.OIDC_CLIENT_SECRET };

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
        if (evt.event === "pull_request" && evt.action === "closed") {
          const pr = evt.payload["pull_request"] as Record<string, unknown> | undefined;
          const number = evt.payload["number"];
          const repo = repoFullName(evt.payload);
          const inst = installationId(evt.payload);
          if (pr?.["merged"] !== true || !repo || !inst || typeof number !== "number") {
            return c.json({ ok: true, ignored: "closed-without-merge" });
          }
          const r = await closeMergedPullRequest(deps, { installationId: inst, repoFullName: repo, prNumber: number });
          return c.json({ ok: true, closing: r.posted });
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

  // ---- Portal (fail-closed: identity secret + GitHub client id configured) ----
  if (env.OIDC_CLIENT_SECRET && env.GITHUB_APP_CLIENT_ID) {
    const cookieOpts = (maxAge: number) => `; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

    app.get("/signin/github", async (c) => {
      const state = randomToken();
      const url = githubAuthorizeUrl(env.GITHUB_APP_CLIENT_ID!, `${portalBase}/callback/github`, state);
      c.header("Set-Cookie", `cla_flow=${await makeStateCookie(env.OIDC_CLIENT_SECRET!, { flow: "github", state }, now())}${cookieOpts(600)}`);
      return c.redirect(url.toString());
    });

    app.get("/callback/github", async (c) => {
      const flow = await readStateCookie(env.OIDC_CLIENT_SECRET!, c.req.header("cookie")?.split(";").find((x) => x.trim().startsWith("cla_flow="))?.split("=").slice(1).join("="), now());
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!flow || flow["flow"] !== "github" || !code || !state || state !== flow["state"]) {
        return c.json({ error: "invalid or expired sign-in state" }, 400);
      }
      const token = await exchangeGithubCode(env.GITHUB_APP_CLIENT_ID!, env.OIDC_CLIENT_SECRET!, code, `${portalBase}/callback/github`, state, fetcher);
      const user = await fetchGithubUser(token, fetcher);
      // Handle proven — now the identity round (JIT via GitHub upstream).
      const discovery = await discover(identity.issuer, fetcher, now());
      const redirectUri = `${portalBase}/callback/ribose`;
      const auth = await authorizationRequest(discovery, identity.clientId, redirectUri, randomToken);
      c.header("Set-Cookie", `cla_flow=${await makeStateCookie(env.OIDC_CLIENT_SECRET!, { flow: "ribose", state: auth.state, verifier: auth.verifier, ghLogin: user.login.toLowerCase(), ghId: String(user.id) }, now())}${cookieOpts(600)}`);
      return c.redirect(auth.url.toString());
    });

    app.get("/callback/ribose", async (c) => {
      const cookieHeader = c.req.header("cookie") ?? "";
      const readCookie = (name: string) => cookieHeader.split(";").find((x) => x.trim().startsWith(`${name}=`))?.split("=").slice(1).join("=");
      const flow = await readStateCookie(env.OIDC_CLIENT_SECRET!, readCookie("cla_flow"), now());
      const code = c.req.query("code");
      if (!flow || flow["flow"] !== "ribose" || !code || !flow["ghLogin"]) {
        return c.json({ error: "invalid or expired sign-in state" }, 400);
      }
      const discovery = await discover(identity.issuer, fetcher, now());
      const idToken = await exchangeCode(discovery, identity.clientId, env.OIDC_CLIENT_SECRET!, `${portalBase}/callback/ribose`, code, flow["verifier"]!, fetcher);
      const claims = await verifyIdToken(discovery, idToken, identity.issuer, identity.clientId, fetcher, now());

      // Both identities proven: write the LINK record (append-only).
      const api = new GithubApi({ fetcher, now, appId: env.GITHUB_APP_ID ?? "", privateKeyPem: (env.APP_PRIVATE_KEY ?? "").replaceAll("\\n", "\n"), tokenCache: TOKEN_CACHE, etagCache: ETAG_CACHE });
      await appendRecord(
        { api, installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now },
        "link",
        { ribose_id_sub: claims.sub, github_login: flow["ghLogin"], github_id: Number(flow["ghId"]), linked_at: new Date(now()).toISOString(), source: "portal-dual-flow" },
      );

      const csrf = newCsrfToken();
      c.header("Set-Cookie", `${SESSION_COOKIE}=${await makeSessionCookie(env.OIDC_CLIENT_SECRET!, { sub: claims.sub, login: flow["ghLogin"], githubId: Number(flow["ghId"]), email: typeof claims.email === "string" ? claims.email : undefined, emailVerified: claims.email_verified === true }, now())}${cookieOpts(8 * 3600)}`);
      c.header("Set-Cookie", `${CSRF_COOKIE}=${csrf}${cookieOpts(8 * 3600)}`, { append: true });
      c.header("Set-Cookie", `cla_flow=; Path=/; HttpOnly; Max-Age=0`, { append: true });
      return c.redirect(`${portalBase}/agreements`);
    });

    // ---- My agreements + ICLA signing (docs/design.md §4) ----
    const ses = async (c: { req: { header: (h: string) => string | undefined } }) => sessionOf(env, c.req.header("cookie"), now());

    app.get("/agreements", async (c) => {
      const session = await ses(c);
      if (!session) return c.json({ error: "sign in required" }, 401);
      const view = await signerView(env, fetcher, now, session.login);
      return c.json({
        bound: { ribose_id_sub: session.sub, github_login: session.login, github_id: session.githubId },
        email: session.email ?? null,
        email_verified: session.emailVerified === true,
        ...view,
      });
    });

    // The exact text of any edition ever deployed, hash-verified before
    // serving, with the hash displayed (docs/design.md §3.10).
    app.get("/agreements/text/:kind/:version", async (c) => {
      if (!(await ses(c))) return c.json({ error: "sign in required" }, 401);
      const kind = c.req.param("kind");
      if (kind !== "icla" && kind !== "ocla") return c.json({ error: "unknown kind" }, 404);
      const e = editionText(GENERATED_CONFIG, kind, c.req.param("version"));
      if (!e) return c.json({ error: "no such edition" }, 404);
      return c.json({ kind, version: c.req.param("version"), sha256: e.sha256, text: e.text });
    });

    const iclaEdition = editionText(GENERATED_CONFIG, "icla", GENERATED_CONFIG.legal.current.icla)!;

    app.get("/icla", async (c) => {
      const session = await ses(c);
      if (!session) return c.json({ error: "sign in required" }, 401);
      const csrf = readCookie(c.req.header("cookie"), CSRF_COOKIE) ?? newCsrfToken();
      const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign the Individual CLA</title></head>
<body>
<h1>Individual Contributor License Agreement — v${GENERATED_CONFIG.legal.current.icla}</h1>
<p>Signing as <strong>@${session.login}</strong>${session.email ? ` (${session.email}${session.emailVerified ? ", verified" : ", unverified"})` : ""}</p>
<pre id="cla-text">${iclaEdition.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>
<p>sha256: <code>${iclaEdition.sha256}</code></p>
<form method="post" action="/icla/sign">
<input type="hidden" name="csrf" value="${csrf}">
<label><input type="checkbox" name="terms" required> I agree to the terms above (edition ${GENERATED_CONFIG.legal.current.icla}, sha256 ${iclaEdition.sha256})</label><br>
<label><input type="checkbox" name="past" value="yes" required> This agreement includes ALL my previous contributions to Ribose projects</label><br>
<button type="submit">Sign</button>
</form>
</body></html>`;
      return c.html(html);
    });

    app.post("/icla/sign", async (c) => {
      const session = await ses(c);
      if (!session) return c.json({ error: "sign in required" }, 401);
      const form = await c.req.parseBody();
      if (!csrfOk(c.req.header("cookie"), form["csrf"] as string)) return c.json({ error: "csrf mismatch" }, 403);
      if (form["terms"] !== "on") return c.json({ error: "the CLA terms consent is required" }, 400);
      const pastIncluded = form["past"] === "yes";
      if (!pastIncluded && form["past_declined"] !== "yes") return c.json({ error: "the past-contributions election is required (affirm, or decline explicitly)" }, 400);

      const api = portalApi(env, fetcher, now);
      const { path, commitSha } = await appendRecord(
        { api, installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now },
        "icla",
        {
          ribose_id_sub: session.sub,
          github_login: session.login,
          github_id: session.githubId,
          name: (form["name"] as string) ?? "",
          email: (form["email"] as string) || session.email || "",
          email_verified: session.emailVerified === true && ((form["email"] as string) || session.email) === session.email,
          alt_email: (form["alt_email"] as string) || null,
          country: (form["country"] as string) ?? "",
          claEdition: { kind: "icla", version: GENERATED_CONFIG.legal.current.icla, textSha256: iclaEdition.sha256 },
          signed_at: new Date(now()).toISOString(),
          source: "portal",
          past_contributions_included: pastIncluded,
        },
      );
      return c.json({ signed: true, record: path, commit: commitSha, past_contributions_included: pastIncluded });
    });

    // The must-specify election surface (docs/design.md §3.11): the bot's
    // signed link lands here; only the committer may elect; recording
    // triggers an immediate re-check.
    app.get("/attribute", async (c) => {
      const session = await readSessionCookie(env.OIDC_CLIENT_SECRET!, c.req.header("cookie")?.split(";").find((x) => x.trim().startsWith(`${SESSION_COOKIE}=`))?.split("=").slice(1).join("="), now());
      if (!session) return c.json({ error: "sign in required" }, 401);
      const tokenData = await readAttributionToken(env.OIDC_CLIENT_SECRET!, c.req.query("t"), now());
      if (!tokenData) return c.json({ error: "invalid or expired attribution link" }, 400);
      if (session.login !== tokenData.login.toLowerCase()) return c.json({ error: "only the committer may elect" }, 403);
      const chosen = tokenData.options.find((o) => optionKey(o) === c.req.query("pick"));
      if (!chosen) return c.json({ error: "pick is not among the offered agreements" }, 400);

      const api = new GithubApi({ fetcher, now, appId: env.GITHUB_APP_ID ?? "", privateKeyPem: (env.APP_PRIVATE_KEY ?? "").replaceAll("\\n", "\n"), tokenCache: TOKEN_CACHE, etagCache: ETAG_CACHE });
      await appendRecord(
        { api, installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now },
        "attribution",
        { id: randomToken(), repo: tokenData.repo, pr: tokenData.pr, login: session.login, agreement: chosen, recorded_at: new Date(now()).toISOString() },
      );
      const sha = await fetchPrHeadSha(api, tokenData.installationId, tokenData.repo, tokenData.pr);
      const deps: EnforcementDeps = { api, config: GENERATED_CONFIG, staff: {}, attributionSecret: env.OIDC_CLIENT_SECRET };
      await evaluatePullRequest(deps, { installationId: tokenData.installationId, repoFullName: tokenData.repo, prNumber: tokenData.pr, headSha: sha });
      return c.json({ recorded: true, agreement: chosen });
    });

    app.post("/signout", async (c) => {
      const cookieHeader = c.req.header("cookie") ?? "";
      const readCookie = (name: string) => cookieHeader.split(";").find((x) => x.trim().startsWith(`${name}=`))?.split("=").slice(1).join("=");
      const session = await readSessionCookie(env.OIDC_CLIENT_SECRET!, readCookie(SESSION_COOKIE), now());
      if (!session) return c.json({ error: "no session" }, 401);
      c.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
      c.header("Set-Cookie", `${CSRF_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
      return c.json({ ok: true });
    });
  }

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}

export { resetOidcCaches };

function reposFromInstallation(payload: Record<string, unknown>): string[] {
  const repos = payload["repositories"];
  return Array.isArray(repos) ? repos.map((r) => (r as Record<string, unknown>)["full_name"] as string).filter(Boolean) : [];
}
