# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`riboseinc/cla` — the Ribose CLA system: a generalized, instance-agnostic
GitHub App (Cloudflare Worker + Hono + D1) enforcing Contributor License
Agreements across all Ribose GitHub orgs. Public, BSD-3-Clause. The
complete design and the deployment runbook live in the private instance
repository (`ribosei/cla-instance`, estate members only); implementation
tracking is THIS repo's issues (master: #16). **This project is worked entirely in this
repo's issues — it is separate from any external estate ledger.**

## The gates — all green before any change is done

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # wrangler deploy --dry-run
```

Single file/case: `npm test -- test/foo.test.ts`, `npm test -- -t "name"`.

## Binding constraints

1. **Kernel purity** — the evaluation kernel is a pure function (zero
   I/O). Transport and SQL live strictly above/below it. Specs drive the
   real app via `app.fetch` and real fixtures — **no doubles of kernel
   interfaces**.
2. **Instance-agnostic** — zero deployment-specific values compiled in
   (repos, hosts, orgs are config). Acceptance test: a second instance
   boots config-only.
3. **Fail-closed** — unset secrets close surfaces; store/GitHub failures
   produce honest failing checks, never silent passes. Postures never
   soften.
4. **Append-only legal data** — signature/agreement records are never
   rewritten; corrections are new records. CLA texts are append-only
   editions (deprecation marks `current`, files are never deleted).
5. **Coverage precedence** (kernel): allowlist -> current ICLA ->
   current OCLA Schedule A (mods folded in order) -> staff employment
   via identity-service roles. Multiple paths => must-specify, never
   guess. Contractors are deliberately not employment-covered.
6. **Editions are content-addressed** — `{kind, version, text_sha256}`;
   staleness is evaluated lazily; no migration jobs.
7. **Least privilege** — the App never configures branch protection
   (administration: write is never requested); blocking is the required
   status check, configured by humans.
8. **Git posture** — feature branches + rebase-merge PRs; **never stack
   PRs: at most ONE pull request open at a time** (open the next only
   after the previous merges); never commit to main; CI runs the gates
   and never deploys; deploys are deliberate owner actions from the
   instance repo. Owner runbook: `ribosei/cla-instance` → `docs/runbook.md`.
