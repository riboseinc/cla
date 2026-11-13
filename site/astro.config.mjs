import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import vue from "@astrojs/vue";
import tailwindcss from "@tailwindcss/vite";

// The CLA site: static pages + Vue islands (client), with the ONE
// server endpoint /api/[...path] delegating to the Hono app (the
// protocol surface keeps its routes and its spec suite untouched).
export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  vite: {
    plugins: [tailwindcss()],
    server: { fs: { allow: ["../.."] } },
  },
  integrations: [vue()],
});
