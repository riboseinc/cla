-- Staff-console audit trail (docs/design.md §4, §11): every ops action
-- lands here with actor, action, and target — the D1 twin of the
-- append-only records the actions create.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
