-- The open-PR index for the write-back sweep (metanorma/ci#515 follow-up,
-- rnpgp/rnp#2587 evidence): populated from the pull_request webhooks the
-- app already receives (opened / synchronize / reopened / closed). The
-- sweep reads a login's open PRs directly instead of enumerating every
-- installation and repository per login — the O(estate) walk measured
-- hours to reach rnpgp/rnp#2587 after a signature (signed 16:48, check
-- green only at 22:30 when a maintainer reopened the PR). Operational
-- state only; the legal truth stays in the data repo.
CREATE TABLE IF NOT EXISTS open_prs (
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  login TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  head_sha TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, pr)
);
CREATE INDEX IF NOT EXISTS idx_open_prs_login ON open_prs (login);
