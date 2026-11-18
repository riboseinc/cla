/**
 * Join-request queue (D1): operational state only. The LEGAL outcome
 * of an approval is an ocla-mod record in the data repo; this store
 * just tracks pending work for the PoC console (docs/design.md §4).
 */
import type { Env } from "../env";

export type JoinRequest = {
  id: string;
  oclaId: string;
  login: string;
  riboseSub: string;
  email: string | null;
  requestedAt: string;
  status: "pending" | "approved" | "rejected";
  decidedBy?: string | null;
  decidedAt?: string | null;
};

type D1Result<T> = { results?: T[] };
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T>(): Promise<D1Result<T>>;
      first<T>(): Promise<T | null>;
    };
  };
}

export const d1 = (env: Env): D1Like | undefined => env.DB as D1Like | undefined;

export async function hasPendingRequest(db: D1Like, oclaId: string, login: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM join_requests WHERE ocla_id = ? AND login = ? AND status = 'pending' LIMIT 1")
    .bind(oclaId, login.toLowerCase())
    .first<{ id: string }>();
  return row !== null;
}

export async function requestJoin(
  db: D1Like,
  data: { oclaId: string; login: string; riboseSub: string; email?: string | null; requestedAt: string; id: string },
): Promise<void> {
  await db
    .prepare("INSERT INTO join_requests (id, ocla_id, login, ribose_sub, email, requested_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
    .bind(data.id, data.oclaId, data.login.toLowerCase(), data.riboseSub, data.email ?? null, data.requestedAt)
    .run();
}

export async function pendingRequests(db: D1Like, oclaId: string): Promise<JoinRequest[]> {
  const res = await db
    .prepare("SELECT * FROM join_requests WHERE ocla_id = ? AND status = 'pending' ORDER BY requested_at")
    .bind(oclaId)
    .all<Record<string, unknown>>();
  return (res.results ?? []).map(rowToRequest);
}

export async function decideRequest(db: D1Like, id: string, decision: "approved" | "rejected", by: string, at: string): Promise<boolean> {
  const row = await db.prepare("SELECT id, status FROM join_requests WHERE id = ? LIMIT 1").bind(id).first<{ id: string; status: string }>();
  if (!row || row.status !== "pending") return false;
  await db.prepare("UPDATE join_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").bind(decision, by, at, id).run();
  return true;
}

const rowToRequest = (r: Record<string, unknown>): JoinRequest => ({
  id: String(r["id"]),
  oclaId: String(r["ocla_id"]),
  login: String(r["login"]),
  riboseSub: String(r["ribose_sub"]),
  email: (r["email"] as string) ?? null,
  requestedAt: String(r["requested_at"]),
  status: r["status"] as JoinRequest["status"],
  decidedBy: (r["decided_by"] as string) ?? null,
  decidedAt: (r["decided_at"] as string) ?? null,
});

/** Staff-console audit trail (migrations/0002). Fail-soft: an audit
 *  failure never blocks the action it records, but it THROWS on test
 *  fixtures that pass a db. */
export async function audit(db: D1Like | undefined, entry: { actor: string; action: string; target?: string; detail?: string; at: string; id: string }): Promise<void> {
  if (!db) return;
  await db
    .prepare("INSERT INTO audit_log (id, at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(entry.id, entry.at, entry.actor, entry.action, entry.target ?? null, entry.detail ?? null)
    .run();
}

// ---- commit-email verification challenges (issue #115) ----

export type EmailChallenge = {
  id: string;
  tokenHash: string;
  riboseSub: string;
  login: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string | null;
};

export async function createEmailChallenge(
  db: D1Like,
  data: { id: string; tokenHash: string; riboseSub: string; login: string; email: string; createdAt: string; expiresAt: string },
): Promise<void> {
  await db
    .prepare("INSERT INTO email_challenges (id, token_hash, ribose_sub, login, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(data.id, data.tokenHash, data.riboseSub, data.login.toLowerCase(), data.email.toLowerCase(), data.createdAt, data.expiresAt)
    .run();
}

/** The live (unconsumed, unexpired) challenge for a token hash. */
export async function liveEmailChallenge(db: D1Like, tokenHash: string, nowIso: string): Promise<EmailChallenge | undefined> {
  const row = await db
    .prepare("SELECT * FROM email_challenges WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? LIMIT 1")
    .bind(tokenHash, nowIso)
    .first<Record<string, unknown>>();
  return row ? rowToEmailChallenge(row) : undefined;
}

/** One-time consume: false when another click already spent the link. */
export async function consumeEmailChallenge(db: D1Like, id: string, at: string): Promise<boolean> {
  const row = await db.prepare("SELECT id, consumed_at FROM email_challenges WHERE id = ? LIMIT 1").bind(id).first<{ id: string; consumed_at: string | null }>();
  if (!row || row.consumed_at) return false;
  await db.prepare("UPDATE email_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").bind(at, id).run();
  return true;
}

const rowToEmailChallenge = (r: Record<string, unknown>): EmailChallenge => ({
  id: String(r["id"]),
  tokenHash: String(r["token_hash"]),
  riboseSub: String(r["ribose_sub"]),
  login: String(r["login"]),
  email: String(r["email"]),
  createdAt: String(r["created_at"]),
  expiresAt: String(r["expires_at"]),
  consumedAt: (r["consumed_at"] as string) ?? null,
});

// ---- the write-back sweep queue (issue #59) ----

export async function enqueueSweep(db: D1Like, login: string): Promise<void> {
  await db
    .prepare("INSERT INTO sweep_queue (login, queued_at, attempts, cursor) VALUES (?, ?, 0, NULL) ON CONFLICT (login) DO UPDATE SET queued_at = excluded.queued_at")
    .bind(login.toLowerCase(), new Date().toISOString())
    .run();
}

/** The oldest queued login, with its saved cursor (null = start fresh). */
export async function claimSweep(db: D1Like): Promise<{ login: string; attempts: number; cursor: unknown } | undefined> {
  const row = await db
    .prepare("SELECT login, attempts, cursor FROM sweep_queue ORDER BY queued_at ASC LIMIT 1")
    .bind()
    .first<{ login: string; attempts: number; cursor: unknown }>();
  return row ?? undefined;
}

export async function saveSweepCursor(db: D1Like, login: string, attempts: number, cursor: unknown): Promise<void> {
  await db
    .prepare("UPDATE sweep_queue SET attempts = ?, cursor = ? WHERE login = ?")
    .bind(attempts, cursor === null ? null : JSON.stringify(cursor), login)
    .run();
}

export async function completeSweep(db: D1Like, login: string): Promise<void> {
  await db
    .prepare("DELETE FROM sweep_queue WHERE login = ?")
    .bind(login)
    .run();
}
