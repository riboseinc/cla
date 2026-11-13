import { Hono } from "hono";
import { KERNEL_VERSION } from "@riboseinc/cla-kernel";
import type { Env } from "./env";
import type { FetchLike } from "./github/api";
import { GENERATED_CONFIG } from "./generated/config";
import { parseEvent, verifyWebhookSignature, installationId, repoFullName } from "./github/webhook";
import { GithubApi } from "./github/api";
import { evaluatePullRequest, closeMergedPullRequest, handleAgreeCommand, preRegisterRepos, type EnforcementDeps } from "./enforcement/handler";
import { discover, authorizationRequest, exchangeCode, verifyIdToken, resetOidcCaches } from "./portal/oidc";
import { githubAuthorizeUrl, exchangeGithubCode, fetchGithubUser, randomToken } from "./portal/github-oauth";
import { SESSION_COOKIE, CSRF_COOKIE, makeSessionCookie, readSessionCookie, makeStateCookie, readStateCookie, newCsrfToken } from "./portal/session";
import { readAttributionToken, optionKey } from "./portal/attribution";
import { readCompletionToken, isAgreeCommand } from "./portal/completion";
import { signEnrollmentToken, readEnrollmentToken } from "./portal/enroll";
import { loadSnapshot } from "./store/load";
import { makeListRecords } from "./store/github-store";
import { kernelEditions } from "./config";
import { d1, hasPendingRequest, requestJoin, pendingRequests, decideRequest, audit } from "./store/db";
import { verifyEvidence } from "./store/evidence";
import { sha256Hex } from "./portal/oidc";
import { sendMail, mailDeps } from "./notify/mail";
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

  // Current edition pointers (public — versions + hashes only, never
  // the signer record): the site islands render the instrument from here.
  app.get("/editions", (c) => {
    const e = kernelEditions(GENERATED_CONFIG);
    return c.json({ icla: e.icla, ocla: e.ocla });
  });

  // Status-service probe target: content-assertable, cheap, honest.
  app.get("/healthz", (c) =>
    c.json({ service: "ribose-cla", status: "ok", kernel: KERNEL_VERSION, instance: GENERATED_CONFIG.instance.name }),
  );

  // Deployed edition text is public: it is the agreement a signer must
  // read BEFORE signing in (and the hash is displayed alongside it).
  // No session, no portal secret required.
  app.get("/agreements/text/:kind/:version", (c) => {
    const kind = c.req.param("kind");
    if (kind !== "icla" && kind !== "ocla") return c.json({ error: "unknown kind" }, 404);
    const e = editionText(GENERATED_CONFIG, kind, c.req.param("version"));
    if (!e) return c.json({ error: "no such edition" }, 404);
    return c.json({ kind, version: c.req.param("version"), sha256: e.sha256, text: e.text });
  });

  // The public landing: an HONEST statement of what is armed. Dark
  // surfaces say so — no fake links, no raw 404 for a human visitor.
  const portalArmed = Boolean(env.OIDC_CLIENT_SECRET && env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET);
  const enforcementArmed = Boolean(env.WEBHOOK_SECRET && env.APP_PRIVATE_KEY && env.GITHUB_APP_ID);
  app.get("/", (c) => {
    const name = GENERATED_CONFIG.instance.name;
    const rows = [
      `Enforcement (webhook + <code>cla/${GENERATED_CONFIG.github.appSlug === "TODO-stage-1" ? "ribose" : GENERATED_CONFIG.github.appSlug}</code> checks): ${enforcementArmed ? "<strong>operational</strong>" : "awaiting GitHub App connection"}`,
      `Signing portal: ${portalArmed ? '<strong>operational</strong>' : 'awaiting GitHub App connection'}`,
    ];
    const links = portalArmed
      ? `<ul>
<li><a href="/icla">Sign the Individual CLA</a></li>
<li><a href="/organizations">Join your organization's CLA</a></li>
<li><a href="/agreements">My agreements</a></li>
</ul>`
      : `<p>Sign-in opens once the GitHub App is connected (setup in progress).</p>`;
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name} — CLA</title></head>
<body style="font-family:sans-serif;max-width:40em;margin:4em auto;line-height:1.5">
<h1>${name} — Contributor License Agreements</h1>
<ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul>
${links}
<p style="color:#666">Fail-closed posture: closed surfaces answer 404 and nothing is ever faked.</p>
</body></html>`);
  });

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
      const deps: EnforcementDeps = { api, config: GENERATED_CONFIG, fetcher, serviceToken: env.SERVICE_TOKEN, attributionSecret: env.OIDC_CLIENT_SECRET };

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
        if (evt.event === "issue_comment" && evt.action === "created") {
          const comment = evt.payload["comment"] as Record<string, unknown> | undefined;
          const issue = evt.payload["issue"] as Record<string, unknown> | undefined;
          const number = evt.payload["number"] ?? issue?.["number"];
          const repo = repoFullName(evt.payload);
          const inst = installationId(evt.payload);
          const bodyText = typeof comment?.["body"] === "string" ? (comment["body"] as string) : "";
          const commenter = comment?.["user"] && typeof comment["user"] === "object" ? ((comment["user"] as Record<string, unknown>)["login"] as string | undefined) : undefined;
          const isPr = issue?.["pull_request"] !== undefined;
          const prAuthor = issue?.["user"] && typeof issue["user"] === "object" ? ((issue["user"] as Record<string, unknown>)["login"] as string | undefined) : undefined;
          if (!comment || !issue || !repo || !inst || typeof number !== "number" || !commenter || !prAuthor) {
            return c.json({ error: "payload missing expected fields" }, 400);
          }
          if (!isPr || commenter.endsWith("[bot]") || !isAgreeCommand(bodyText)) {
            return c.json({ ok: true, ignored: "not an agree command on a PR" });
          }
          const r = await handleAgreeCommand(deps, { installationId: inst, repoFullName: repo, prNumber: number, commenter, prAuthor });
          return c.json({ ok: true, replied: r.replied, reason: r.reason });
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
        console.error("webhook failure", (e as Error).stack ?? String(e));
        return c.json({ error: `enforcement failed: ${(e as Error).message}` }, 503);
      }
    });
  }

  // ---- Portal (fail-closed: identity secret + GitHub client id configured) ----
  if (env.OIDC_CLIENT_SECRET && env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET) {
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
      const token = await exchangeGithubCode(env.GITHUB_APP_CLIENT_ID!, env.GITHUB_APP_CLIENT_SECRET!, code, `${portalBase}/callback/github`, state, fetcher);
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
      // a completion flow insists the proven handle is the invited login
      if (flow["tlogin"] && flow["tlogin"] !== flow["ghLogin"]) {
        return c.json({ error: "only the committer may complete this signature" }, 403);
      }
      return c.redirect(`${portalBase}${flow["next"] ?? "/agreements"}`);
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
    // serving, with the hash displayed (docs/design.md §3.10). Public:
    // served above the portal gate so the signing paper renders first.
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
<h2>Your details</h2>
<label>Full name <input name="name" placeholder="Full legal name" required></label><br>
<label>Email <input name="email" type="email" value="${session.email ?? ""}" required></label><br>
<label>Alternate email (optional) <input name="alt_email" type="email"></label><br>
<label>Country <input name="country" placeholder="Country of residence" required></label><br>
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
      const deps: EnforcementDeps = { api, config: GENERATED_CONFIG, fetcher, serviceToken: env.SERVICE_TOKEN, attributionSecret: env.OIDC_CLIENT_SECRET };
      await evaluatePullRequest(deps, { installationId: tokenData.installationId, repoFullName: tokenData.repo, prNumber: tokenData.pr, headSha: sha });
      return c.json({ recorded: true, agreement: chosen });
    });

    // The comment-command completion surface (docs/design.md §3.12): the
    // bot's signed link proves the handle; if the browser session doesn't
    // match, the user re-proves it through the dual flow, then lands on
    // the ICLA form.
    app.get("/icla/complete", async (c) => {
      const tokenData = await readCompletionToken(env.OIDC_CLIENT_SECRET!, c.req.query("t"), now());
      if (!tokenData) return c.json({ error: "invalid or expired completion link" }, 400);
      const session = await ses(c);
      if (session && session.login === tokenData.login) return c.redirect(`${portalBase}/icla`);
      // re-prove the handle through the dual flow, then land on /icla
      const state = randomToken();
      const url = githubAuthorizeUrl(env.GITHUB_APP_CLIENT_ID!, `${portalBase}/callback/github`, state);
      c.header("Set-Cookie", `cla_flow=${await makeStateCookie(env.OIDC_CLIENT_SECRET!, { flow: "github", state, next: "/icla", tlogin: tokenData.login }, now())}${cookieOpts(600)}`);
      return c.redirect(url.toString());
    });

    // ---- OCLA self-service + PoC console (docs/design.md §4, issue #7) ----

    const slugify = (name: string): string =>
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const domainOf = (email: string | undefined): string | undefined =>
      email?.includes("@") ? email.split("@")[1]!.toLowerCase() : undefined;
    const rowKey = (l: string): string => l.trim().toLowerCase();

    // role check: the session subject holds a live org_admin grant for this ocla
    const orgAdminOf = async (oclaId: string, sub: string) => {
      const { roles } = await loadSnapshot(
        { listRecords: makeListRecords(portalApi(env, fetcher, now), GENERATED_CONFIG.github.dataInstallationId, GENERATED_CONFIG.github.dataRepo) },
        kernelEditions(GENERATED_CONFIG),
      );
      return roles.some((r) => r.oclaId === oclaId && r.riboseSub === sub);
    };

    app.get("/sign-ocla", async (c) => {
      const session = await ses(c);
      if (!session) return c.json({ error: "sign in required" }, 401);
      const csrf = readCookie(c.req.header("cookie"), CSRF_COOKIE) ?? newCsrfToken();
      return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Execute an Organization CLA</title></head><body>
<h1>Organization CLA — v${GENERATED_CONFIG.legal.current.ocla}</h1>
<p>Signing as <strong>@${session.login}</strong> (${session.email ?? "no email on account"}${session.emailVerified ? ", verified" : ", UNVERIFIED"})</p>
<p><em>The signatory and the Point of Contact must hold a VERIFIED mailbox on a declared company domain (OCLA §4 puts signing authority on your representation; the on-domain mailbox is the app's integrity gate).</em></p>
<pre id="ocla-text">${(editionText(GENERATED_CONFIG, "ocla", GENERATED_CONFIG.legal.current.ocla)!.text).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>
<p>sha256: <code>${editionText(GENERATED_CONFIG, "ocla", GENERATED_CONFIG.legal.current.ocla)!.sha256}</code></p>
<form method="post" action="/sign-ocla">
<input type="hidden" name="csrf" value="${csrf}">
<h2>Company</h2>
<input name="org_name" placeholder="Legal name" required><br>
<input name="org_address" placeholder="Address" required><br>
<input name="org_country" placeholder="Country" required><br>
<input name="domains" placeholder="email domains, comma-separated (e.g. mtg.example, mgt.example)" required><br>
<h2>Signatory (you)</h2>
<input name="signatory_name" placeholder="Your name" required><br>
<input name="signatory_email" placeholder="Your corporate email (verified)" required><br>
<input name="signatory_title" placeholder="Job title" required><br>
<input name="signatory_github" placeholder="GitHub username (optional — N/A allowed)"><br>
<h2>Point of Contact</h2>
<input name="poc_name" placeholder="PoC name" required><br>
<input name="poc_email" placeholder="PoC corporate email" required><br>
<input name="poc_phone" placeholder="PoC phone"><br>
<h2>Schedule A — designated employees (one per line: <code>github_login | Name | email | Job title</code>)</h2>
<textarea name="schedule_a" rows="5" placeholder="tj-91 | Johannes Roth | johannes@mtg.example | Senior Software Developer"></textarea><br>
<label><input type="checkbox" name="terms" required> I am authorized to bind this organization; we agree to the terms above (edition ${GENERATED_CONFIG.legal.current.ocla})</label><br>
<label><input type="checkbox" name="past" value="yes"> This agreement includes ALL designated employees' previous contributions to Ribose projects</label><br>
<button type="submit">Execute the OCLA</button>
</form></body></html>`);
    });

    app.post("/sign-ocla", async (c) => {
      const session = await ses(c);
      if (!session) return c.json({ error: "sign in required" }, 401);
      const form = await c.req.parseBody();
      if (!csrfOk(c.req.header("cookie"), form["csrf"] as string)) return c.json({ error: "csrf mismatch" }, 403);
      if (form["terms"] !== "on") return c.json({ error: "the OCLA terms consent is required" }, 400);
      const pastIncluded = form["past"] === "yes";

      const orgName = String(form["org_name"] ?? "").trim();
      const domains = String(form["domains"] ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
      const signatoryEmail = String(form["signatory_email"] ?? "").trim();
      const pocEmail = String(form["poc_email"] ?? "").trim();
      const scheduleLines = String(form["schedule_a"] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (!orgName || domains.length === 0) return c.json({ error: "org name and at least one email domain are required" }, 400);

      // the integrity gate: the signatory's VERIFIED mailbox on a declared domain
      if (!session.emailVerified || !session.email || !domains.includes(domainOf(session.email) ?? "")) {
        return c.json({ error: "the signatory must hold a VERIFIED mailbox on a declared company domain — verify such an email on your identity account first" }, 403);
      }
      if (!domains.includes(domainOf(signatoryEmail) ?? "") || !domains.includes(domainOf(pocEmail) ?? "")) {
        return c.json({ error: "signatory and PoC emails must be on declared company domains" }, 400);
      }

      const api = portalApi(env, fetcher, now);
      const covered: Array<{ githubLogin: string; githubId: number; email: string | null; name: string; title: string }> = [];
      for (const line of scheduleLines) {
        const [loginRaw, name = "", emailRaw = "", title = ""] = line.split("|").map((p) => p.trim());
        if (!loginRaw) continue;
        const res = await api.request(GENERATED_CONFIG.github.dataInstallationId, "GET", `/users/${encodeURIComponent(loginRaw)}`);
        if (res.status !== 200) return c.json({ error: `Schedule A: GitHub username "${loginRaw}" does not resolve` }, 400);
        const u = JSON.parse(res.body) as { login: string; id: number };
        covered.push({ githubLogin: u.login.toLowerCase(), githubId: u.id, email: emailRaw || null, name, title });
      }

      const { snapshot } = await loadSnapshot(
        { listRecords: makeListRecords(api, GENERATED_CONFIG.github.dataInstallationId, GENERATED_CONFIG.github.dataRepo) },
        kernelEditions(GENERATED_CONFIG),
      );
      const slug = slugify(orgName);
      if (snapshot.oclas.some((o) => o.orgSlug === slug)) {
        return c.json({ error: `an organization with slug "${slug}" already exists — duplicates are merged by staff` }, 400);
      }

      const oclaId = randomToken();
      const edition = editionText(GENERATED_CONFIG, "ocla", GENERATED_CONFIG.legal.current.ocla)!;
      await appendRecord({ api, installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now }, "ocla", {
        id: oclaId,
        orgSlug: slug,
        claEdition: { kind: "ocla", version: GENERATED_CONFIG.legal.current.ocla, textSha256: edition.sha256 },
        covered: covered.map((r) => ({ githubLogin: r.githubLogin, email: r.email, githubId: r.githubId, name: r.name, title: r.title })),
        signatory: { name: String(form["signatory_name"] ?? ""), email: signatoryEmail, title: String(form["signatory_title"] ?? ""), githubLogin: String(form["signatory_github"] ?? "") || null },
        poc: { name: String(form["poc_name"] ?? ""), email: pocEmail, phone: String(form["poc_phone"] ?? "") || null },
        domains,
        pastContributionsIncluded: pastIncluded,
        signedAt: new Date(now()).toISOString(),
        source: "portal",
        riboseIdSub: session.sub,
      });
      const enrollToken = await signEnrollmentToken(env.OIDC_CLIENT_SECRET!, oclaId, pocEmail, now());
      for (const to of [signatoryEmail, pocEmail]) {
        await sendMail(
          mailDeps(env, GENERATED_CONFIG.coverage.notify.from, false, fetcher),
          to,
          `Organization CLA executed for ${orgName}`,
          `The Software Grant and Organization CLA v${GENERATED_CONFIG.legal.current.ocla} for ${orgName} was executed by ${session.login} (sha256 ${edition.sha256}). Schedule A lists ${covered.length} designated employees. You will receive a Point-of-Contact enrollment link separately.`,
        );
      }
      return c.json({ signed: true, oclaId, orgSlug: slug, coveredCount: covered.length, pocEnrollmentUrl: `${portalBase}/enroll?t=${enrollToken}` });
    });

    // PoC enrollment: the invited email must be VERIFIED on the claimant's identity account
    app.get("/enroll", async (c) => {
      const session = await ses(c);
      if (!session) return c.json({ error: "sign in required" }, 401);
      const t = await readEnrollmentToken(env.OIDC_CLIENT_SECRET!, c.req.query("t"), now());
      if (!t) return c.json({ error: "invalid or expired enrollment link" }, 400);
      if (!session.emailVerified || (session.email ?? "").toLowerCase() !== t.email) {
        return c.json({ error: `enrollment requires a VERIFIED identity account for ${t.email}` }, 403);
      }
      const api = portalApi(env, fetcher, now);
      await appendRecord({ api, installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now }, "role", {
        id: randomToken(),
        role: "org_admin",
        oclaId: t.oclaId,
        riboseSub: session.sub,
        githubLogin: session.login,
        granted_at: new Date(now()).toISOString(),
        source: "enrollment",
      });
      return c.json({ enrolled: true, oclaId: t.oclaId });
    });

    // PRIVACY (owner decision 2026-11-13): signers and covered orgs are
    // NOT enumerable. There is no org-list endpoint — an employee joins
    // by the exact slug their PoC shares; existence reveals itself only
    // to someone who already knows the name.
    app.post("/organizations/:slug/join", async (c) => {
      const session = await ses(c);
      if (!session) return c.json({ error: "sign in required" }, 401);
      const db = d1(env);
      if (!db) return c.json({ error: "join queue unavailable (D1 unconfigured)" }, 503);
      const loaded = await loadSnapshot(
        { listRecords: makeListRecords(portalApi(env, fetcher, now), GENERATED_CONFIG.github.dataInstallationId, GENERATED_CONFIG.github.dataRepo) },
        kernelEditions(GENERATED_CONFIG),
      );
      const snapshot = loaded.snapshot;
      const ocla = snapshot.oclas.find((o) => o.orgSlug === c.req.param("slug"));
      if (!ocla) return c.json({ error: "no such organization" }, 404);
      if (ocla.edition.textSha256 !== kernelEditions(GENERATED_CONFIG).ocla.textSha256) {
        return c.json({ error: "this organization's OCLA is stale (re-sign pending) — join requests are paused" }, 409);
      }
      if (await hasPendingRequest(db, ocla.id, session.login)) return c.json({ error: "you already have a pending request" }, 409);
      await requestJoin(db, {
        id: randomToken(),
        oclaId: ocla.id,
        login: session.login,
        riboseSub: session.sub,
        email: session.email ?? null,
        requestedAt: new Date(now()).toISOString(),
      });
      const pending = await pendingRequests(db, ocla.id);
      const digest = pending.length >= GENERATED_CONFIG.coverage.notify.digestThreshold;
      const pocEmail = loaded.oclaPocs[ocla.id];
      const mail = pocEmail
        ? await sendMail(
            mailDeps(env, GENERATED_CONFIG.coverage.notify.from, digest, fetcher),
            pocEmail,
            `CLA join request for ${ocla.orgSlug}`,
            `${session.login} (${session.email ?? "no email"}) requests Schedule-A coverage under your Organization CLA. Approve or reject at ${portalBase}/admin-orgs/${ocla.orgSlug}.`,
          )
        : { sent: false };
      return c.json({ requested: true, org: ocla.orgSlug, notified: mail.sent });
    });

    const adminOf = async (c: { req: { param: (k: string) => string; header: (h: string) => string | undefined } }) => {
      const session = await ses(c);
      if (!session) return { error: "sign in required" as const, status: 401 as const };
      const loaded = await loadSnapshot(
        { listRecords: makeListRecords(portalApi(env, fetcher, now), GENERATED_CONFIG.github.dataInstallationId, GENERATED_CONFIG.github.dataRepo) },
        kernelEditions(GENERATED_CONFIG),
      );
      const { snapshot, roles } = loaded;
      const ocla = snapshot.oclas.find((o) => o.orgSlug === c.req.param("slug"));
      if (!ocla) return { error: "no such organization" as const, status: 404 as const };
      if (!roles.some((r) => r.oclaId === ocla.id && r.riboseSub === session.sub)) {
        return { error: "org admin role required" as const, status: 403 as const };
      }
      return { session, snapshot, roles, mods: loaded.mods, ocla };
    };

    app.get("/admin-orgs", async (c) => {
      const session = await ses(c);
      if (!session) return c.json({ error: "sign in required" }, 401);
      const { snapshot, roles } = await loadSnapshot(
        { listRecords: makeListRecords(portalApi(env, fetcher, now), GENERATED_CONFIG.github.dataInstallationId, GENERATED_CONFIG.github.dataRepo) },
        kernelEditions(GENERATED_CONFIG),
      );
      const mine = roles.filter((r) => r.riboseSub === session.sub).map((r) => r.oclaId);
      return c.json({ organizations: snapshot.oclas.filter((o) => mine.includes(o.id)).map((o) => ({ slug: o.orgSlug })) });
    });

    app.get("/admin-orgs/:slug", async (c) => {
      const auth = await adminOf(c);
      if ("error" in auth) return c.json({ error: auth.error }, auth.status);
      const db = d1(env);
      const pending = db ? await pendingRequests(db, auth.ocla.id) : [];
      return c.json({
        org: { id: auth.ocla.id, slug: auth.ocla.orgSlug, edition: auth.ocla.edition },
        effectiveScheduleA: auth.ocla.covered,
        mods: auth.mods.filter((m) => m.oclaId === auth.ocla.id),
        pendingJoinRequests: pending,
      });
    });

    app.post("/admin-orgs/:slug/decide", async (c) => {
      const auth = await adminOf(c);
      if ("error" in auth) return c.json({ error: auth.error }, auth.status);
      const db = d1(env);
      if (!db) return c.json({ error: "join queue unavailable" }, 503);
      const form = await c.req.parseBody();
      if (!csrfOk(c.req.header("cookie"), form["csrf"] as string)) return c.json({ error: "csrf mismatch" }, 403);
      const id = String(form["request_id"] ?? "");
      const decision = form["decision"] === "approve" ? "approved" : form["decision"] === "reject" ? "rejected" : null;
      if (!decision) return c.json({ error: "decision must be approve/reject" }, 400);

      let requesterEmail: string | undefined;
      if (decision === "approved") {
        const pending = await pendingRequests(db, auth.ocla.id);
        const req = pending.find((r) => r.id === id);
        if (!req) return c.json({ error: "no such pending request" }, 404);
        requesterEmail = req.email ?? undefined;
        // the LEGAL outcome: an append-only Schedule-A addition, actor recorded
        await appendRecord({ api: portalApi(env, fetcher, now), installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now }, "ocla-mod", {
          id: randomToken(),
          oclaId: auth.ocla.id,
          add: [{ githubLogin: req.login, email: req.email, name: req.riboseSub, title: "joined via PoC approval" }],
          recordedAt: new Date(now()).toISOString(),
          actorRiboseSub: auth.session.sub,
          reason: "join-request approval",
        });
      } else {
        const pending = await pendingRequests(db, auth.ocla.id);
        requesterEmail = pending.find((r) => r.id === id)?.email ?? undefined;
      }
      const ok = await decideRequest(db, id, decision, auth.session.sub, new Date(now()).toISOString());
      if (requesterEmail) {
        await sendMail(
          mailDeps(env, GENERATED_CONFIG.coverage.notify.from, false, fetcher),
          requesterEmail,
          `Your CLA coverage request was ${decision}`,
          decision === "approved"
            ? `Your request for Schedule-A coverage under ${auth.ocla.orgSlug}'s Organization CLA was APPROVED. Future contributions are covered from now on.`
            : `Your request for Schedule-A coverage under ${auth.ocla.orgSlug}'s Organization CLA was rejected by the organization's Point of Contact.`,
        );
      }
      return c.json({ decided: decision, applied: ok });
    });

    app.post("/admin-orgs/:slug/add", async (c) => {
      const auth = await adminOf(c);
      if ("error" in auth) return c.json({ error: auth.error }, auth.status);
      const form = await c.req.parseBody();
      if (!csrfOk(c.req.header("cookie"), form["csrf"] as string)) return c.json({ error: "csrf mismatch" }, 403);
      const login = String(form["login"] ?? "").trim();
      if (!login) return c.json({ error: "login required" }, 400);
      const api = portalApi(env, fetcher, now);
      const res = await api.request(GENERATED_CONFIG.github.dataInstallationId, "GET", `/users/${encodeURIComponent(login)}`);
      if (res.status !== 200) return c.json({ error: `GitHub username "${login}" does not resolve` }, 400);
      const u = JSON.parse(res.body) as { login: string; id: number };
      await appendRecord({ api, installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now }, "ocla-mod", {
        id: randomToken(),
        oclaId: auth.ocla.id,
        add: [{ githubLogin: u.login.toLowerCase(), githubId: u.id, email: (form["email"] as string) || null, name: (form["name"] as string) || "", title: (form["title"] as string) || "" }],
        recordedAt: new Date(now()).toISOString(),
        actorRiboseSub: auth.session.sub,
        reason: "direct add by PoC",
      });
      return c.json({ added: u.login.toLowerCase() });
    });

    app.post("/admin-orgs/:slug/remove", async (c) => {
      const auth = await adminOf(c);
      if ("error" in auth) return c.json({ error: auth.error }, auth.status);
      const form = await c.req.parseBody();
      if (!csrfOk(c.req.header("cookie"), form["csrf"] as string)) return c.json({ error: "csrf mismatch" }, 403);
      const login = String(form["login"] ?? "").trim().toLowerCase();
      if (!login) return c.json({ error: "login required" }, 400);
      if (!auth.ocla.covered.some((row) => rowKey(row.githubLogin) === login)) return c.json({ error: "that login is not on the Schedule A" }, 404);
      await appendRecord({ api: portalApi(env, fetcher, now), installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now }, "ocla-mod", {
        id: randomToken(),
        oclaId: auth.ocla.id,
        removeLogins: [login],
        recordedAt: new Date(now()).toISOString(),
        actorRiboseSub: auth.session.sub,
        reason: "removed by PoC",
      });
      return c.json({ removed: login });
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

  // ---- Staff console (fail-closed: no ops token -> does not exist) ----
  // Remedies and legacy import ONLY — onboarding is self-service; the
  // console never gates it. Every action audits to D1.
  if (env.OPS_TOKEN) {
    const opsGuard = (c: { req: { header: (h: string) => string | undefined } }) => c.req.header("authorization") === `Bearer ${env.OPS_TOKEN}`;
    const ops = async (c: { req: { header: (h: string) => string | undefined } }, action: string, target: string, detail?: string) =>
      audit(d1(env), { actor: "ops", action, target, detail, at: new Date(now()).toISOString(), id: randomToken() });
    const opsForm = async (c: { req: { json: () => Promise<unknown>; parseBody: () => Promise<Record<string, unknown>>; header: (h: string) => string | undefined } }) => {
      const ct = c.req.header("content-type") ?? "";
      return ct.includes("json") ? await c.req.json().catch(() => ({})) : Object.fromEntries((await c.req.parseBody().catch(() => ({}))) as never);
    };

    app.post("/admin/void", async (c) => {
      if (!opsGuard(c)) return c.json({ error: "forbidden" }, 403);
      const body = (await opsForm(c)) as Record<string, unknown>;
      const targetId = String(body["target_id"] ?? "");
      const reason = String(body["reason"] ?? "");
      if (!targetId || !reason) return c.json({ error: "target_id and reason are required" }, 400);
      const api = portalApi(env, fetcher, now);
      const { path } = await appendRecord({ api, installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now }, "revocation", {
        id: randomToken(),
        target: { id: targetId },
        reason,
        by: "ops",
        at: new Date(now()).toISOString(),
      });
      await ops(c, "void", targetId, reason);
      return c.json({ voided: targetId, record: path });
    });

    app.post("/admin/backfill-ocla", async (c) => {
      if (!opsGuard(c)) return c.json({ error: "forbidden" }, 403);
      const body = (await opsForm(c)) as Record<string, unknown>;
      const evidence = body["evidence"] as { path?: string; sha256?: string } | undefined;
      if (!evidence?.path || !evidence?.sha256) return c.json({ error: "evidence pointer (path + sha256) is required" }, 400);
      // fail-closed: the scan must exist in the offline repo and hash-match
      const ev = await verifyEvidence({ readOffline: async (p) => {
        const api = portalApi(env, fetcher, now);
        const res = await api.request(GENERATED_CONFIG.github.dataInstallationId, "GET", `/repos/${GENERATED_CONFIG.github.offlineRepo}/contents/${p}`);
        if (res.status !== 200) return undefined;
        const doc = JSON.parse(res.body) as { content?: string; encoding?: string };
        return doc.encoding === "base64" ? Buffer.from(doc.content ?? "", "base64").toString("utf8") : (doc.content ?? "");
      } }, { repo: GENERATED_CONFIG.github.offlineRepo, path: evidence.path, sha256: evidence.sha256 });
      if (!ev.valid) return c.json({ error: ev.reason }, 400);

      const orgSlug = String(body["org_slug"] ?? "").trim();
      const covered = Array.isArray(body["covered"]) ? (body["covered"] as Array<Record<string, unknown>>) : [];
      if (!orgSlug || covered.length === 0) return c.json({ error: "org_slug and covered[] are required" }, 400);
      const oclaVersion = String(body["ocla_version"] ?? GENERATED_CONFIG.legal.current.ocla);
      const edition = editionText(GENERATED_CONFIG, "ocla", oclaVersion);
      if (!edition) return c.json({ error: "unknown ocla edition" }, 400);
      const api = portalApi(env, fetcher, now);
      const oclaId = randomToken();
      const { path } = await appendRecord({ api, installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now }, "ocla", {
        id: oclaId,
        orgSlug,
        claEdition: { kind: "ocla", version: oclaVersion, textSha256: edition.sha256 },
        covered: covered.map((r) => ({ githubLogin: String(r["githubLogin"] ?? "").toLowerCase(), email: (r["email"] as string) ?? null, name: (r["name"] as string) ?? "", title: (r["title"] as string) ?? "" })),
        signatory: (body["signatory"] ?? {}) as Record<string, unknown>,
        poc: (body["poc"] ?? {}) as Record<string, unknown>,
        domains: Array.isArray(body["domains"]) ? body["domains"] : [],
        pastContributionsIncluded: true,
        signedAt: String(body["signed_at"] ?? new Date(now()).toISOString()),
        source: "backfill",
        note: String(body["note"] ?? ""),
        evidence: { repo: GENERATED_CONFIG.github.offlineRepo, path: evidence.path, sha256: evidence.sha256 },
      });
      await ops(c, "backfill-ocla", oclaId, orgSlug);
      let enrollUrl: string | undefined;
      const pocEmail = ((body["poc"] ?? {}) as Record<string, unknown>)["email"];
      if (typeof pocEmail === "string" && pocEmail.includes("@")) {
        enrollUrl = `${portalBase}/enroll?t=${await signEnrollmentToken(env.OIDC_CLIENT_SECRET ?? "ops", oclaId, pocEmail, now())}`;
      }
      return c.json({ imported: oclaId, orgSlug, record: path, evidenceVerified: true, pocEnrollmentUrl: enrollUrl });
    });

    app.post("/admin/backfill-icla", async (c) => {
      if (!opsGuard(c)) return c.json({ error: "forbidden" }, 403);
      const body = (await opsForm(c)) as Record<string, unknown>;
      const evidence = body["evidence"] as { path?: string; sha256?: string } | undefined;
      if (!evidence?.path || !evidence?.sha256) return c.json({ error: "evidence pointer is required" }, 400);
      const ev = await verifyEvidence({ readOffline: async (p) => {
        const api = portalApi(env, fetcher, now);
        const res = await api.request(GENERATED_CONFIG.github.dataInstallationId, "GET", `/repos/${GENERATED_CONFIG.github.offlineRepo}/contents/${p}`);
        if (res.status !== 200) return undefined;
        const doc = JSON.parse(res.body) as { content?: string; encoding?: string };
        return doc.encoding === "base64" ? Buffer.from(doc.content ?? "", "base64").toString("utf8") : (doc.content ?? "");
      } }, { repo: GENERATED_CONFIG.github.offlineRepo, path: evidence.path, sha256: evidence.sha256 });
      if (!ev.valid) return c.json({ error: ev.reason }, 400);
      const login = String(body["github_login"] ?? "").toLowerCase();
      const sub = String(body["ribose_id_sub"] ?? "");
      if (!login || !sub) return c.json({ error: "github_login and ribose_id_sub are required" }, 400);
      const iclaVersion = String(body["icla_version"] ?? GENERATED_CONFIG.legal.current.icla);
      const edition = editionText(GENERATED_CONFIG, "icla", iclaVersion);
      if (!edition) return c.json({ error: "unknown icla edition" }, 400);
      const api = portalApi(env, fetcher, now);
      const { path } = await appendRecord({ api, installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now }, "icla", {
        ribose_id_sub: sub,
        github_login: login,
        github_id: Number(body["github_id"] ?? 0),
        name: String(body["name"] ?? ""),
        email: String(body["email"] ?? ""),
        email_verified: false,
        alt_email: null,
        country: String(body["country"] ?? ""),
        claEdition: { kind: "icla", version: iclaVersion, textSha256: edition.sha256 },
        signedAt: String(body["signed_at"] ?? new Date(now()).toISOString()),
        source: "backfill",
        past_contributions_included: true,
        note: String(body["note"] ?? "evidence-backed import; identity binding follows at first portal sign-in"),
        evidence: { repo: GENERATED_CONFIG.github.offlineRepo, path: evidence.path, sha256: evidence.sha256 },
      });
      await ops(c, "backfill-icla", login);
      return c.json({ imported: login, record: path, evidenceVerified: true });
    });

    app.post("/admin/invite-poc", async (c) => {
      if (!opsGuard(c)) return c.json({ error: "forbidden" }, 403);
      const body = (await opsForm(c)) as Record<string, unknown>;
      const oclaId = String(body["ocla_id"] ?? "");
      const email = String(body["email"] ?? "").toLowerCase();
      if (!oclaId || !email.includes("@")) return c.json({ error: "ocla_id and email are required" }, 400);
      const token = await signEnrollmentToken(env.OIDC_CLIENT_SECRET ?? "ops", oclaId, email, now());
      await ops(c, "invite-poc", oclaId, email);
      return c.json({ inviteUrl: `${portalBase}/enroll?t=${token}`, gatedOn: `${email} verified on the claimant's identity account` });
    });

    app.post("/admin/approve-request", async (c) => {
      if (!opsGuard(c)) return c.json({ error: "forbidden" }, 403);
      const body = (await opsForm(c)) as Record<string, unknown>;
      const db = d1(env);
      if (!db) return c.json({ error: "join queue unavailable" }, 503);
      const requestId = String(body["request_id"] ?? "");
      const pending = (await db.prepare("SELECT * FROM join_requests WHERE id = ? LIMIT 1").bind(requestId).first<Record<string, unknown>>());
      if (!pending) return c.json({ error: "no such request" }, 404);
      // staff bypass: the LEGAL outcome is still the append-only mod, recorded as staff-approved
      const api = portalApi(env, fetcher, now);
      await appendRecord({ api, installationId: GENERATED_CONFIG.github.dataInstallationId, dataRepo: GENERATED_CONFIG.github.dataRepo, now }, "ocla-mod", {
        id: randomToken(),
        oclaId: String(pending["ocla_id"]),
        add: [{ githubLogin: String(pending["login"]), email: (pending["email"] as string) ?? null, name: String(pending["ribose_sub"]), title: "staff bypass approval" }],
        recordedAt: new Date(now()).toISOString(),
        actorRiboseSub: "ops",
        reason: "staff bypass approval",
      });
      await decideRequest(db, requestId, "approved", "ops", new Date(now()).toISOString());
      await ops(c, "bypass-approve", requestId);
      return c.json({ approved: requestId });
    });

    app.get("/admin/audit", async (c) => {
      if (!opsGuard(c)) return c.json({ error: "forbidden" }, 403);
      const db = d1(env);
      if (!db) return c.json({ entries: [] });
      const res = await db.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT 100").bind().all<Record<string, unknown>>();
      return c.json({ entries: res.results ?? [] });
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
