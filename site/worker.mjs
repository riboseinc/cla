// The deployable worker (the identity worker.mjs pattern): the Astro
// site serves the pages; /api/* mounts the protocol surface (Hono,
// unchanged routes, unchanged spec suite).
import astroWorker from "./dist/server/entry.mjs";
import { createApp } from "../src/app";

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

    // The site's protocol calls (/api/icla/sign, /api/agreements, ...)
    // map to the Hono routes with /api stripped.
    if (url.pathname.startsWith("/api/")) {
      const inner = new Request(new URL(url.pathname.replace(/^\/api/, "") || "/", url.origin), request);
      return apiApp.fetch(inner, env, ctx);
    }

    return astroWorker.fetch(request, env, ctx);
  },
};
