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
