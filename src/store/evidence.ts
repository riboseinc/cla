import type { Evidence } from "./records";

/**
 * Evidence verification (docs/design.md §8): a backfill record's
 * `evidence` pointer must resolve to real content in the offline repo
 * whose sha256 matches what the record pins. Missing/mismatched
 * evidence = the record reads as unsigned — fail-closed, with the
 * reason surfaced.
 */
export type EvidenceDeps = {
  /** Raw content of `path` in the offline repo, or undefined if absent. */
  readOffline: (path: string) => Promise<string | undefined>;
};

export async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type EvidenceVerdict = { valid: true } | { valid: false; reason: string };

export async function verifyEvidence(deps: EvidenceDeps, evidence: Evidence): Promise<EvidenceVerdict> {
  if (!evidence.path || !evidence.sha256) return { valid: false, reason: "evidence pointer incomplete" };
  const content = await deps.readOffline(evidence.path);
  if (content === undefined) return { valid: false, reason: `evidence file missing: ${evidence.path}` };
  const actual = await sha256Hex(content);
  if (actual !== evidence.sha256.toLowerCase()) {
    return { valid: false, reason: `evidence hash mismatch for ${evidence.path}` };
  }
  return { valid: true };
}
