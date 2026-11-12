import { Hono } from "hono";
import { KERNEL_VERSION } from "@riboseinc/cla-kernel";
import type { Env } from "./env";

/**
 * The Hono app behind a thin worker entry (src/index.ts). Dependency
 * injection keeps every leg drivable from vitest via app.fetch with
 * no doubles (docs/design.md §10).
 */
export function createApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Status-service probe target: content-assertable, cheap, honest.
  app.get("/healthz", (c) =>
    c.json({ service: "ribose-cla", status: "ok", kernel: KERNEL_VERSION }),
  );

  // Enforcement and portal legs land per issues #4–#11. Unset secrets
  // close them (fail-closed); until then the routes do not exist.
  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}
