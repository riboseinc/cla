# Ribose CLA

Contributor License Agreement enforcement for the Ribose GitHub estate,
as a single installable GitHub App. BSD-3-Clause. One codebase, many
deployments — the Ribose estate is one configuration instance, never a
code edit.

## What it does

- Enforces the `cla/ribose` required status check on pull requests
  (fail-closed: any store/config/GitHub failure = failing check with an
  honest reason, never a silent pass).
- Binds every signature to a **Ribose ID subject** (the estate OpenID
  Connect provider) with a **verified GitHub handle** — GitHub-first
  sign-in JIT-creates the identity account; the portal proves handle
  ownership itself.
- Stores signatures as append-only records in a private git repo (the
  source of truth), bound to **content-addressed CLA editions** — a new
  edition lazily flips all prior signatures stale (re-sign; no
  migration jobs).
- **Individual CLA (ICLA)**: self-service, including signing by PR
  comment (`@ribose-cla agree` -> one-click completion).
- **Organization CLA (OCLA)**: fully self-service execution by a
  signatory (verified mailbox on a declared company domain); the org's
  Point of Contact manages Schedule A and approves employee join
  requests; the remedy for fraudulent agreements is revocation.
- Multi-agreement contributors **specify per PR** under which agreement
  a contribution is made; after merge the App posts which CLA the
  contribution was made under.
- Staff vs contractors are distinguished by **identity-service roles**;
  contractors deliberately sign or join like any external contributor.

## The four-repo architecture

| Repo | Visibility | Holds |
|------|-----------|-------|
| this repo | public, BSD-3-Clause | the generalized app (kernel + worker + portal) |
| config instance | private | deployment config + versioned CLA legal texts (deploy INTO the app) |
| live data | private | append-only signature/agreement records — the legal source of truth |
| offline evidence | private | scans of pre-app signed agreements, hash-referenced as evidence |

Private repo names are deployment config, not code: the app hardcodes
none of them.

## Architecture & development

See [`docs/design.md`](docs/design.md) for the complete design
(actors, flows, kernel, webhook mechanics, config/data schemas,
fail-closed postures, rollout). Work is tracked in this repo's issues
— start at the master tracker: #16.

The estate development pattern: pure kernel + thin worker, instance
config compiled at deploy, three gates green before any change is done
(`npm run typecheck`, `npm test`, `npm run build` — a deploy dry-run),
vitest specs driving the real app with no test doubles of kernel
interfaces.
