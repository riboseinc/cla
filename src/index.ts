import type { Env } from "./env";
import { createApp } from "./app";

/**
 * Thin entrypoint: bind the real runtime environment into the app.
 * All logic lives in src/app.ts and below; nothing here is testable
 * logic (docs/design.md §5).
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createApp(env).fetch(request);
  },
};
