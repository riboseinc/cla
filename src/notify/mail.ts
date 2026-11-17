import type { FetchLike } from "../github/api";

/**
 * Transactional mail, the estate three-posture pattern (docs/design.md
 * §7 notify), resolved best-first:
 *
 *   1. the Cloudflare Email Service `send_email` binding (env.EMAIL) —
 *      the preferred transport; domain authentication is the operator
 *      act (SPF/DKIM on the sending subdomain);
 *   2. a Resend-shaped HTTPS provider (MAIL_PROVIDER_URL +
 *      MAIL_PROVIDER_KEY), the fallback posture;
 *   3. the honest no-op — never a silent drop, a thrown error, or mail
 *      to a suspicious destination.
 *
 * Digest mode lets a flooded org fall back to one daily summary instead
 * of per-request spam.
 */

/** The minimal shape of the Cloudflare Email Service binding. */
export type EmailBinding = {
  send(message: { from: string; to: string; subject: string; text?: string }): Promise<unknown>;
};

export type MailDeps = {
  fetcher: FetchLike;
  binding?: EmailBinding;
  providerUrl?: string;
  providerKey?: string;
  from: string;
  digestMode?: boolean;
};

export type MailResult = { sent: boolean; reason?: string };

export async function sendMail(deps: MailDeps, to: string, subject: string, text: string): Promise<MailResult> {
  if (deps.digestMode) return { sent: false, reason: "digest mode: the org summary will carry it" };
  if (!to.includes("@")) return { sent: false, reason: "refusing to send to a non-address" };
  try {
    if (deps.binding) {
      await deps.binding.send({ from: deps.from, to, subject, text });
      return { sent: true };
    }
    if (!deps.providerUrl || !deps.providerKey) {
      return { sent: false, reason: "mail transport unconfigured (honest no-op)" };
    }
    // Bare invocation: a global fetch called as a method is an illegal
    // invocation in Workers.
    const fetcher = deps.fetcher;
    const res = await fetcher(deps.providerUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.providerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: deps.from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { sent: false, reason: `provider answered ${res.status}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `mail transport failed: ${(e as Error).message}` };
  }
}

export const mailDeps = (
  env: { MAIL_PROVIDER_URL?: string; MAIL_PROVIDER_KEY?: string; EMAIL?: EmailBinding },
  from: string,
  digestMode: boolean,
  fetcher: FetchLike,
): MailDeps => ({
  fetcher,
  binding: env.EMAIL && typeof env.EMAIL.send === "function" ? env.EMAIL : undefined,
  providerUrl: env.MAIL_PROVIDER_URL,
  providerKey: env.MAIL_PROVIDER_KEY,
  from,
  digestMode,
});
