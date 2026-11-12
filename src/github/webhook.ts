/**
 * Webhook delivery verification (docs.design §5): HMAC-SHA256 over
 * the RAW body, hex-digested, constant-time compared. Never re-serialize
 * JSON before verifying.
 */

const encoder = new TextEncoder();

export async function hmacHex(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(content));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality over equal-length buffers; unequal length fails immediately (length is not secret). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = await hmacHex(secret, rawBody);
  return timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(signatureHeader.slice(7)));
}

// ---- event parsing (minimal, just what the handlers consume) ----

export type WebhookEvent = {
  event: string;
  action?: string;
  payload: Record<string, unknown>;
};

export function parseEvent(eventHeader: string | undefined, rawBody: string): WebhookEvent | undefined {
  if (!eventHeader) return undefined;
  try {
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    return { event: eventHeader, action: typeof payload["action"] === "string" ? payload["action"] : undefined, payload };
  } catch {
    return undefined;
  }
}

export function repoFullName(payload: Record<string, unknown>): string | undefined {
  const repo = payload["repository"];
  return repo && typeof repo === "object" ? (repo as Record<string, unknown>)["full_name"] as string | undefined : undefined;
}

export function installationId(payload: Record<string, unknown>): number | undefined {
  const inst = payload["installation"];
  return inst && typeof inst === "object" ? (inst as Record<string, unknown>)["id"] as number | undefined : undefined;
}
