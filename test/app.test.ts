import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { GENERATED_CONFIG } from "../src/generated/config";

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

describe("public editions", () => {
  it("serves version + hash pointers without the text or any signer data", async () => {
    const res = await createApp({}).request("/editions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, { version: string; textSha256: string }>;
    expect(body["icla"]!.version).toBe(GENERATED_CONFIG.legal.current.icla);
    expect(body["ocla"]!.textSha256).toBe(GENERATED_CONFIG.legal.editions.ocla[0]!.sha256);
  });
});
