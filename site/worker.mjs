// The deployable worker (the identity worker.mjs pattern): the Astro
// site serves the pages; /api/* mounts the protocol surface (Hono,
// unchanged routes, unchanged spec suite).
import astroWorker from "./dist/server/entry.mjs";
import { createApp } from "../src/app";

// The site-wide Content-Security-Policy (task: parity with the
// identity service). The islands need inline bootstrap scripts; forms
// post same-origin only.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const withCsp = (response) => {
  const res = new Response(response.body, response);
  res.headers.set("Content-Security-Policy", CSP);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return res;
};

export default {
  async fetch(request, env, ctx) {
    // createApp gates its webhook + portal routes on the REAL env.
    // Building it once at module load with {} left those routes
    // unregistered for every request (webhook -> 404, portal -> 404).
    const apiApp = createApp(env);
    const url = new URL(request.url);

    // The GitHub webhook keeps its /api prefix: this is the hook URL
    // registered on the App (https://cla.ribose.com/api/github/webhook).
    if (url.pathname === "/api/github/webhook") {
      return apiApp.fetch(request, env, ctx);
    }

    // Probes and the OAuth round-trip live at the ROOT (the App's
    // callback URLs and the runbook's health probe are root paths).
    if (url.pathname === "/healthz" || url.pathname.startsWith("/signin/") || url.pathname.startsWith("/callback/")) {
      return apiApp.fetch(request, env, ctx);
    }

    // The agreement texts are public documents with clean URLs (the
    // footer links to them directly).
    if (url.pathname.startsWith("/agreements/text/")) {
      return apiApp.fetch(request, env, ctx);
    }

    // The site's protocol calls (/api/icla/sign, /api/agreements, ...)
    // map to the Hono routes with /api stripped.
    if (url.pathname.startsWith("/api/")) {
      const inner = new Request(new URL(url.pathname.replace(/^\/api/, "") || "/", url.origin), request);
      return apiApp.fetch(inner, env, ctx);
    }

    return withCsp(await astroWorker.fetch(request, env, ctx));
  },

  // The write-back sweep's cron tick (issue #59): one bounded drain
  // step per invocation; the cursor persists in D1 between ticks.
  async scheduled(controller, env, ctx) {
    const { drainSweepStep } = await import("../src/enforcement/sweep");
    ctx.waitUntil(drainSweepStep(env));
  },
};