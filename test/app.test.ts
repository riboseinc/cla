import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

describe("smoke: the app answers with content", () => {
  it("/healthz answers 200 with a content-assertable body", async () => {
    const app = createApp({});
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["service"]).toBe("ribose-cla");
    expect(body["status"]).toBe("ok");
  });

  it("unknown routes answer 404 json", async () => {
    const app = createApp({});
    const res = await app.request("/nope");

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("not found");
  });
});
