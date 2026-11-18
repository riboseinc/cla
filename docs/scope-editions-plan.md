# Scope-bound agreement editions — decision matrix and build plan

**Status:** **DECIDED — no scope-bound instrument** (D1 = A, owner, 2026-11-18):
**#119 is closed as not planned.** The BUSL recipient-grant question is
addressed **globally** by CLA edition 1.1 (third draft for counsel, #123): one
instrument covers the whole matrix, so per-scope editions are unnecessary.
D2 = **B2** and D4 = **additional** are recorded only as the fallback if a
scope-bound instrument is ever required for another reason. The material below
is the dormant build plan.

**Tracking:** #116 (decision + counsel brief in
`docs/counsel-brief-116.md`), #117 (license inventory, merged), #118 (clause-7
SPDX gate, merged), #119 (this plan, closed as not planned), **#123 (global
edition 1.1, the active track)**.

This document exists so that the day counsel answers, the build is mechanical:
each answer selects one column below, and the PR order is already fixed.

---

## 0. Decision log

| Date | Decision | By | Consequence |
|---|---|---|---|
| 2026-11-18 | **D1 = A** — no scope-bound instrument is built | owner | No config, kernel, portal or enforcement change. #119 closed as not planned. |
| 2026-11-18 | **D2 = B2** — if a scope supplement is ever required, it is a **distinct instrument kind**, not an ICLA edition | owner (contingent) | Selects §4.3 over §4.2. No code under A. |
| 2026-11-18 | **D4 = additional** — a scope supplement would be an **additional requirement**, never an alternative path | owner (contingent) | Selects the middle column of §4.4. No code under A. |
| 2026-11-18 | **Global CLA edition 1.1** — the recipient-grant ambiguity is closed in one instrument for every scope (#123) | owner | Scope editions are unnecessary; the license position is tracked in #123, not here. |

**Open contingency decisions** (moot while no scope instrument exists): D3
scope granularity, D5 registry/allowlist exemption, D6 coverage outside the
scope, D7 remediation for existing work.

**Revisit triggers:** a scope-bound instrument becomes necessary for a reason
unrelated to the BUSL recipient grant (e.g. a license that cannot be handled by
a global edition); #123 is rejected or withdrawn; the owner changes position.
Until then, nothing here is built.

**Note on the legal premise (updated with #123):** the recipient-grant
ambiguity is **not** accepted under edition 1.0. It is closed by the global
edition 1.1 draft, whose §2/§3 make recipients take solely under the license
Ribose applies. #123 P2–P5 is the active track; this plan does not duplicate it.

---

## 1. Decisions that shape the build

| # | Decision | Status | Where |
|---|---|---|---|
| **D1** | Does a BUSL scope need a **scope-bound** instrument? **A** no — a global edition handles it / **B** yes, a supplement / **C** refuse | **A** (owner, 2026-11-18); the global edition 1.1 is the track (#123) | #116, #123 |
| **D2** | If B: is the supplement **B1** an additive ICLA edition, **B2** a distinct instrument kind, or **B3** a replacing ICLA edition? | **B2** (owner, contingent) | §4 |
| **D3** | Scope granularity: per repo, per org, or both with repo winning | open (contingent) | §5 |
| **D4** | Precedence: the supplement is **additional** to standard coverage, or an **alternative** path | **additional** (owner, contingent) | §4.4 |
| **D5** | Do the separate-agreement registry and the allowlist remain exempt from the supplement? | open (contingent, owner) | §4.4 |
| **D6** | Does a scope signature cover the contributor outside that scope? | open (contingent, counsel) | §4.2 |
| **D7** | Any remediation for work already merged? | open (contingent, counsel) | §12 |

**Settled fallback:** if a scope-bound instrument is ever required for a
reason a global edition cannot express, it is **B2** — a distinct instrument
kind — because its legal act differs from the ICLA's; and it is
**additional**, because an alternative path would let a scoped PR pass on the
standard ICLA alone. **B3 remains rejected** (§4.1). The BUSL recipient-grant
fix is *not* this fallback: it is the global edition 1.1 (#123).


---

## 2. Invariants

These hold under every outcome and constrain every build step:

1. **Kernel purity** — scope logic is a pure function of plain data.
2. **Instance-agnostic** — scopes, instrument names and edition texts are
   instance config; zero conormis values in code.
3. **Content-addressed editions** — `{kind, version, text_sha256}`; a changed
   text is a new edition; staleness is lazy; no migration jobs.
4. **Append-only legal data** — a signature is never rewritten; corrections are
   new records; editions are never deleted.
5. **Fail-closed** — an unknown or unreadable scope fails the check honestly; a
   scoped PR never falls back silently to the standard instruments.
6. **Least privilege** — the App never configures branch protection.
7. **No inference from Licensee** — `conormis/platform` reports `NOASSERTION`
   for its BUSL text; scope is explicit config, never detected.
8. **One PR at a time**; feature branch + rebase-merge; all three gates green.

---

## 3. Outcome A — no scope-bound instrument (**decided**)

**Recorded 2026-11-18. Build: nothing.** #119 is closed as not planned.

- `legal.scope_editions` is not added.
- The report's `scope` field keeps `standard` / `excluded` from #117.
- The recipient-grant ambiguity is addressed globally by CLA edition 1.1
  (#123); no scope instrument is needed to cure it.
- Existing behavior is unchanged for every repository until edition 1.1 flips
  `current` under #123 P3.

This is the cheapest outcome and the reason the issue says "do not start with a
guessed instrument": under A, all of §4–§10 is dead work. It stays here as the
contingency plan, with D2 = B2 and D4 = additional already settled.

---

## 4. Outcomes B and C — the instrument question

### 4.1 The single-current-edition conflict (why B3 is rejected)

The current model has **one current edition per kind**:

- `Editions = { icla: ClaEdition; ocla: ClaEdition }` (`packages/kernel/src/evaluate.ts`)
- `isLive(record, current, revoked)` compares the record's `textSha256` to that
  single current edition.
- `legal.current.{icla,ocla}` is one version string; `currentEditions()` throws
  if it is missing.

"A different ICLA edition for scoped repos" (**B3**) therefore conflicts with
the model: one edition cannot be both globally current and scope-specific, and
making a signature valid in one scope but not another turns staleness into a
scope question with no single answer. A scope edition must be **additive**
(B1) or a **distinct kind** (B2).

Under **B1**, one more fact follows and must be decided by counsel (**D6**): a
record signed against the scope edition has a different hash from the global
current edition, so `isLive` reads it stale outside the scope. Either:

- **B1-strict:** the scope signature covers only its scope; the contributor also
  needs the global ICLA elsewhere. Two signatures for an estate contributor.
- **B1-live:** the scope edition is also accepted as live for the global ICLA.
  This weakens "current edition" semantics: two texts are simultaneously live
  for the same kind.

### 4.2 Form B1 — additive ICLA edition

| Layer | Change |
|---|---|
| Config | `legal.scope_editions`: repo/org → `{ kind: "icla", edition: "<version>", mode }`; the edition is validated in `legal.editions.icla` but is **not** `current` |
| Kernel | `Editions` gains a scope-edition map, or the evaluate input carries the required edition; `collectPaths` accepts the scope edition for a scoped PR (and, per D6, outside it); `isLive` becomes edition-set-aware |
| Store | **no new namespace**: records stay `icla/…`; `claEdition` already carries version + hash |
| Portal | ICLA signing page gains an edition parameter (`?edition=<version>`), renders that text, writes the same `icla` record shape; the current-edition idempotency check must key on the target edition |
| Check | a scoped PR missing the supplement names **"the Conormis BUSL supplement (ICLA vX)"**, not the generic ICLA |
| Attribution | `AgreementRef` stays `{kind:"icla",version}`; the closing statement needs the scope wording to avoid claiming the standard ICLA |
| Report | `path: "icla"`, plus `scope` and the required `edition`; a standard-ICLA-only contributor in a scope reads **scope-outstanding** |

**Cost:** moderate, and it reuses the entire ICLA portal. **Risk:** D6 (two
live texts or two signatures) is a legal/UX choice, not an engineering one.

### 4.3 Form B2 — distinct instrument kind

Use a placeholder name in this plan (`scope`); counsel owns the real name
(e.g. `bcla`, `supplement`).

| Layer | Change |
|---|---|
| Types | `ClaEdition.kind` widens beyond `"icla" | "ocla"`; `Editions` becomes a keyed record or `{icla, ocla, scope?}`; `AgreementRef` gains `{kind:"scope", version, scopeId, scopeName}` |
| Config | `legal.scope_editions` (repo/org → scope id) + `legal.editions.scope` + `legal.current.scope`; gen validates references and hashes |
| Kernel | `collectPaths` queries scope records only; precedence per §4.4; `agreementKey` gains the scope case; must-specify stays for standard paths only |
| Store | new append-only namespace `scope/` (or `supplement/`): `{ id, scope, github_login, email, claEdition, … }`; loader, divergence check, revocation, email fallback all extend |
| Enforcement | check/comment names the exact scope instrument and edition; a stale edition names the edition; closing attribution names it |
| Portal | new page (e.g. `/sign-scope?scope=<id>`) and text route (`/agreements/text/scope/:version` — the current route rejects unknown kinds); `signerView` lists it |
| Report | `path: "scope"` + `scope`; `hasHistoricalRecord` includes scope records |
| Editions route | `/editions` exposes the scope edition(s) |

**Cost:** the full mechanism. **Precedent:** this is the MariaDB BCLA shape.
**Recommendation:** choose B2 if the supplement is a distinct legal act.

### 4.4 Precedence (D4/D5)

Current order (kernel comment): **registry → allowlist → current ICLA → current
OCLA**; multiple live paths ⇒ must-specify, never a guess.

With a scope, the table below is the decision space. "Additional" is the
recommended reading of the owner's position ("contributors accept Ribose's full
license position"); "alternative" would let a scoped PR pass on the standard
ICLA alone, which does not meet the scope's restriction. (The BUSL
recipient-grant fix itself is now the global edition 1.1, #123 — this table is
the fallback if a scope-bound instrument is ever required.)

| Path | Current | Additional (recommended) | Alternative |
|---|---|---|---|
| separate-agreement registry | covered, no signing | **exempt** (D5) — the registry is a separate Ribose agreement, not an external contribution | same |
| allowlist (bots/CI) | covered | **exempt** (D5) | same |
| current ICLA | covered | **not sufficient alone in a scope**; needs the supplement | sufficient |
| current OCLA Schedule A | covered | **not sufficient alone in a scope** | sufficient |
| scope supplement | — | **required** for every human committer in scope | optional path |
| multiple standard paths | must-specify | must-specify still applies; the scope is **not** an election | must-specify |

Two interactions that must not be missed:

1. **The minimal-change control short-circuits `evaluate` before coverage.**
   A 2-line PR in a BUSL scope would skip the scope requirement. The scope check
   must run before, or independently of, that early return.
2. **Bot committers are skipped before coverage.** Unchanged; a bot in a scope
   needs no signature.

### 4.5 Outcome C — refuse scoped contributions

No signing page and no new records. The mechanism is the same config map with
`mode: refuse`:

- Kernel: a human committer in a scoped repo fails closed regardless of
  coverage (registry/allowlist per D5), with a distinct verdict so the check can
  say **why** (not "sign the CLA").
- Check/comment: "Ribose cannot accept contributions to this repository under
  its current agreements" — no signing link, because no signature would help.
- Report: `scope` names the restriction and contributors read
  `scope-blocked`, not `outstanding`.
- Build order is §6 steps 1 + 3 only (config, kernel, enforcement).

---

## 5. Proposed config schema

Not final; it depends on D2/D3. The happy property is that the **map** is the
same under B1/B2/C, only the target differs.

```yaml
legal:
  scope_editions:
    # Repo wins over org; both are allowed (D3).
    conormis/platform:
      scope: busl-2026
    conormis:                 # org-wide default
      scope: busl-2026
  # B2 only: the instrument kind and its editions (B1 points at icla instead).
  editions:
    scope:
      current: "1.0"
      files:
        "1.0": legal/scope/busl-2026.md
  scope_instruments:
    busl-2026:
      # B1: kind: icla, edition: "1.1"
      # B2: kind: scope
      # C:  mode: refuse
      kind: scope
      mode: additional        # or: alternative / refuse
      label: "Conormis BUSL supplement"
```

Validation at gen time (fail-closed): repo/org shape, unknown scope id, missing
edition, missing `current`, duplicate/overlapping keys, invalid `mode`, a scope
that is both `refuse` and has an edition, and unknown keys. The scope map and
all hashes compile into `src/generated/config.ts`.

---

## 6. Build order (PR-sized, one at a time)

**Dormant under D1 = A.** Kept for the contingency; do not start any step
without a recorded reversal of D1.

The order is chosen so each step is independently reviewable and the system is
never half-enforcing.

1. **Config + dormant visibility** — schema, validation, `/editions`, and the
   report's `scope` field reading the map (replacing #117's placeholder). No
   behavior change: an unconfigured map reports `standard`.
2. **Kernel + store** — the scope verdict, edition liveness, record namespace
   (B2) or edition-set (B1), revocations, email fallback. Specs drive the real
   kernel; no doubles.
3. **Enforcement** — check/comment/closing wording; minimal-change interaction;
   must-specify unchanged.
4. **Portal** — scope signing page, text route, one-click link, My agreements,
   CSRF/idempotency.
5. **Report + attribution finalization** — `scope_state`, historical records,
   closing statement wording.
6. **Docs** — `docs/SIGNING.md`, README.

Each step runs the three gates; each is a single PR on a feature branch; no PR
stacks (one open at a time).

---

## 7. Test matrix

Kernel (pure):

- scoped repo + standard ICLA only + additional ⇒ fail, naming the supplement.
- scoped repo + supplement ⇒ pass.
- scoped repo + registry ⇒ exempt (D5) / fail (if D5 goes the other way).
- scoped repo + allowlist ⇒ exempt.
- scoped repo + minimal-change PR ⇒ still requires the supplement.
- out-of-scope repo ⇒ unchanged (regression).
- org-wide scope vs repo override.
- stale supplement edition ⇒ stale, named.
- revoked supplement ⇒ coverage gone.
- unlinked committer matched by verified email (B2 namespace included).
- multiple standard paths + scope ⇒ must-specify preserved, not resolved by the
  scope.
- B1-strict: scope-only signer outside the scope ⇒ not covered (D6); B1-live:
  ⇒ covered.

App-level (`app.fetch`, real fixtures): a scoped PR check names the instrument;
the one-click link signs; the record loads back; the closing statement names it;
a non-committer cannot sign or elect for someone else.

Config: every validation failure above; a second instance declares a scope
config-only and boots.

---

## 8. What engineering needs if D1 ever reverses

Nothing is needed under A. If D1 reverses to B, the remaining answers are:

- **D3** — repo/org granularity (engineering proposal: both, repo wins).
- **D5** — registry/allowlist exemption (owner call).
- **D6** — coverage outside the scope (counsel; only B1 has this fork).
- **D7** — remediation for existing work (counsel).

Everything else (labels, wording, edition names) can follow during the build.
D2 = B2 and D4 = additional are already settled.

---

## 9. Explicitly not in this plan

- no code, config key, or default value under D1 = A;
- no instrument text — counsel owns it;
- no inference of scope from LICENSE/Licensee;
- no branch-protection automation;
- no copyright assignment (a separate instrument, #116 non-goal).
