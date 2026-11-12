/**
 * The single runtime boundary: what the Worker's environment provides.
 * Every secret here is fail-closed when unset — postures never soften
 * (docs/design.md §9).
 */
export type Env = {
  /** GitHub App id (JWT `iss` claim) + private key (PEM) — unset closes all GitHub legs. */
  GITHUB_APP_ID?: string;
  APP_PRIVATE_KEY?: string;
  /** GitHub webhook secret — unset closes the webhook surface. */
  WEBHOOK_SECRET?: string;
  /** The GitHub App's OAuth client id + secret — the user-identity leg. */
  GITHUB_APP_CLIENT_ID?: string;
  /** Ribose ID OIDC confidential-client secret — unset closes the portal. */
  OIDC_CLIENT_SECRET?: string;
  /** Staff console token — unset means /admin answers 404. */
  OPS_TOKEN?: string;
  /** Identity-service subject-roles lookup token (issue #10). */
  SERVICE_TOKEN?: string;
  /** D1 (join-request queue + ephemeral state). */
  DB?: D1Database;
  /** Resend-shaped mail provider; unset = honest no-op (notify leg). */
  MAIL_PROVIDER_URL?: string;
  MAIL_PROVIDER_KEY?: string;

  [key: string]: unknown;
};
