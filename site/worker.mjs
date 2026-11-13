// The deployable worker (the identity worker.mjs pattern): the Astro
// site serves the pages; /api/* mounts the protocol surface (Hono,
// unchanged routes, unchanged spec suite).
import astroWorker from "./dist/server/entry.mjs";
import { createApp } from "../src/app";

const apiApp = createApp({});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const inner = new Request(url.pathname.replace(/^\/api/, "") || "/", request);
      return apiApp.fetch(inner, env, ctx);
    }
    return astroWorker.fetch(request, env, ctx);
  },
};
