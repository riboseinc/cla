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

  // An edition flip (issue #123: 1.1 replaces 1.0 as current) must not
  // strand the superseded text: a signature binds to the edition it was
  // made against, so every compiled edition stays public and
  // hash-addressed, while /editions advertises only the current one.
  it("keeps every compiled edition public but advertises only the current one", async () => {
    const app = createApp({});
    const pointers = (await (await app.request("/editions")).json()) as Record<string, { version: string; textSha256: string }>;
    for (const kind of ["icla", "ocla"] as const) {
      const superseded = GENERATED_CONFIG.legal.editions[kind].filter((e) => e.version !== GENERATED_CONFIG.legal.current[kind]);
      expect(superseded.length).toBeGreaterThan(0);
      for (const edition of superseded) {
        const res = await app.request(`/agreements/text/${kind}/${edition.version}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { sha256: string; text: string };
        expect(body.sha256).toBe(edition.sha256);
        expect(body.text).toBe(edition.text);
        expect(pointers[kind]!.version).not.toBe(edition.version);
      }
    }
  });
});
