import { sha256Hex } from "./oidc";

/**
 * Verified commit emails (issue #115): a contributor adds an address on
 * /agreements, proves the mailbox with a one-time link, and the portal
 * writes an `email/` record binding login + Ribose subject + address.
 * The record is identity only — the login's signature remains the
 * coverage, so verification never duplicates a signature.
 */

/** The verification link is short-lived: a challenge is not a standing grant. */
export const EMAIL_CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A bare addr-spec — what a git author email actually is. Display names
 * and angle brackets are form noise here, not an identity.
 */
export function normalizeCommitEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : undefined;
}

/** The table holds only the hash: a database leak yields no usable link. */
export function emailChallengeHash(token: string): Promise<string> {
  return sha256Hex(token);
}
