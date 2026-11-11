# Ribose CLA system — design

Approved by the system owner 2026-11-11 (design presented and agreed
section by section). Implementation tracking: the issue tracker of this
repo — master tracker #16. Companion research (existing CLA systems
survey, GitHub App mechanics, identity-service audit) informed §5 and
§6; ask the maintainers for the estate-internal copies.

## 1. Overview

A CLA enforcement system for ALL Ribose GitHub orgs, built as a GitHub
App ("Ribose CLA") on the estate stack (Cloudflare Worker + Hono + D1),
with signatures bound to Ribose ID subjects and records held in private
Ribose repos. Fail-closed everywhere; three gates; instance-agnostic
code (the acceptance test: a second instance boots config-only).

**Stack**: Cloudflare Workers + Hono + D1 (ephemeral only), plain Hono
SSR for the portal, Vitest, no doubles of kernel interfaces.

## 2. The four repos

| # | Repo | Visibility | Managed by | Contents |
|---|------|-----------|------------|----------|
| 1 | **riboseinc/cla** (this repo) | Public, BSD-3-Clause | estate devs | The generalized app: kernel + worker + portal. Instance-agnostic; zero deployment hardcoding |
| 2 | Instance config | Private | estate ops + counsel | Deployment config + **versioned CLA legal texts** (`legal/icla/1.0.md`, `legal/ocla/1.0.md`, …, append-only like migrations) |
| 3 | Live signature data | Private | the app (+staff PRs) | The legal record: signatures, modifications, attributions, links, roles, revocations — append-only JSON files |
| 4 | Offline evidence | Private | staff | Scanned pre-app agreements; app reads read-only for evidence verification |

Worker: `ribose-cla` at `cla.ribose.com`. Status check name: `cla/ribose`.
Transactional email subdomain: `notify.ribose.com` (Cloudflare Email
Workers; the corporate mail domain's records are untouched).

## 3. Decision ledger (all owner decisions, 2026-11-11)

1. Build a GitHub App (not cla-assistant/EasyCLA — neither satisfies
   identity binding, data control, and minimal hosting; cla-assistant is
   dormant upstream, GitHub-OAuth-only, and has no corporate CLAs).
2. Four-repo architecture (public app / private config+texts / private
   live data / private offline evidence).
3. Private repo = signature source of truth, read live w/ ETag caching;
   D1 ephemeral only.
4. GitHub-first JIT identity: "Sign in with GitHub" creates/uses a
   Ribose ID account via upstream; the portal verifies handle ownership
   itself via App user-identity OAuth for EVERY signer (identity tokens
   don't carry the handle).
5. Existing signatures: lazy backfill — past ICLA signers are asked to
   re-sign at their next PR (self-service); known OCLAs are imported
   eagerly (evidence-linked) because enforcement would otherwise push
   employees onto the wrong grant path.
6. CLA legal texts live in the config repo and deploy INTO the app;
   signatures bind to content-addressed editions
   `{kind: icla|ocla, version, text_sha256}`; new edition ⇒ lazy
   stale-flip ⇒ re-sign; `legal/` is append-only (texts never deleted,
   so any signed edition stays viewable forever).
7. The org model (from the real documents): OCLA = org entity
   (name/address/country + declared email domains) + signatory
   (GitHub optional — may be N/A) + PoC + Schedule A rows keyed by
   GitHub username. Coverage = login ∈ current Schedule A (mods
   folded) ∨ current ICLA ∨ staff-employment ∨ config allowlist.
8. Signatory authority is the signatory's own representation (OCLA §4);
   on-domain verified mailbox is the app-level integrity gate.
9. **OCLA execution is fully self-service** — no staff review, no
   external e-sign services. The remedy for fakes is voidance (staff
   console revocation; coverage evaporates; PRs re-evaluate honestly).
10. "My agreements" page: every record you're party to, with edition
    + **View text** of the exact version signed (hash-verified).
11. Multi-agreement ambiguity ⇒ PR must specify: check fails with
    per-agreement portal links; the choice is an attribution record;
    unambiguous ⇒ nothing stored. Post-merge closing comment cites the
    agreement per committer. No contributions ledger (PR comments are
    the public record; aggregate reporting derived on demand).
12. Comment-command signing: `@ribose-cla agree` → pre-authenticated
    one-click completion link (fields + past-contributions election +
    Ribose ID binding). Fully-automatic comment signing (Option B,
    GitHub-only record) exists as a config flag, OFF by default,
    counsel's call.
13. Blocking is the App's check run required in branch protection —
    NOT a GitHub Action (no per-repo workflow drift, no repo-editable
    logic). The App pre-registers the check on installation (neutral
    run on default-branch HEAD) so it's requirable immediately.
14. License: BSD-3-Clause.
15. **Staff vs contractors are distinguished in the identity service**
    (Ribose ID org roles) — see §6.
16. Names: "Ribose CLA" app (registered under `riboseinc`), check
    `cla/ribose`, portal `cla.ribose.com`, mail `notify.ribose.com`.

## 4. Identity & portal (cla.ribose.com)

### Actors

| Actor | Auth | GitHub needed | Acts on |
|---|---|---|---|
| Individual contributor | Ribose ID + verified handle (JIT or link) | required | ICLA, join requests, attribution |
| Org signatory | Ribose ID only | optional | executing OCLA |
| Org admin (PoC) | Ribose ID + `org_admin` role | optional | Schedule A, approvals |
| System staff | staff console (ops token) | — | backfill, voidance, bypass |

### Flows

- **ICLA**: sign in with GitHub (JIT Ribose ID) → confirm edition text →
  name/email/alt-email/country (pre-filled; `email_verified` = matches
  the identity-verified address) → **two required consents: terms +
  "includes ALL my previous contributions"** → record.
- **OCLA (self-service)**: sign in → "for an organization" → company
  info + declared email domain(s) → **signatory unlocks only with a
  verified mailbox on a declared domain** → signatory section (title =
  own §4 representation) + PoC (also on-domain) + Schedule A (usernames
  resolved live vs GitHub API — canonical lowercase login + numeric id,
  typos caught) → past-contributions election (org-wide) → sign →
  record (`source: portal`) → PoC enrollment link auto-sends.
- **Join (employee under employer's OCLA)**: portal → search org →
  request coverage (pre-filled) → pending request in D1 → **PoC
  approves** (their contractual role) → modification record in the
  data repo (actor recorded) → covered at next evaluation; both
  parties emailed. No OCLA at your org → sign ICLA or point your org
  to `/sign-ocla`.
- **PoC console**: effective Schedule A (original + mods in order),
  pending requests, history; approve/reject/add (live username
  validation)/remove — every action lands as a modification record.
- **PoC enrollment**: system-issued signed token (HMAC binding
  pattern), single-use, email-bound, 14-day expiry; gate = identity
  account holds the invited email VERIFIED. PoC replacement: current
  PoC nominates + staff confirms (OCLA §8 spirit).
- **Voidance**: staff console can revoke any agreement (revocation
  record → coverage evaporates → honest re-evaluation).
- **My agreements**: ICLA signatures + OCLA coverages (your Schedule A
  row as recorded, status current/removed/stale) + pending requests +
  attributions; `GET /agreements/text/:kind/:version` serves the
  hash-verified edition text with the hash displayed.

### Portal surface map

```
/                            landing (GitHub JIT primary)
/icla                        ICLA signing (handle-bound)
/sign-ocla                   OCLA execution
/organizations, /organizations/:slug/join
/admin-orgs, /admin-orgs/:slug   PoC console (role-gated)
/agreements, /agreements/text/:kind/:version
/attribute?pr=…&agreement=…      must-specify links
/admin                       staff console (ops token)
/callback/github, /callback/ribose
/healthz                     status probe target
```

## 5. Enforcement kernel (pure) + webhook mechanics

`packages/kernel` — zero I/O, vitest-legislatable, no doubles:

```
evaluate(committers[], storeSnapshot, config, editions, staffMap) →
  per-login: covered{path: staff|icla|ocla|allowlist, agreement?}
             | missing | must-specify[agreement refs]
  PR verdict: pass | fail(missing[]) | fail(must-specify)
```

- Precedence: allowlist → current ICLA (login) → current OCLA Schedule A
  (mods folded in order) → staff-employment (identity role, §6).
  Multiple paths ⇒ must-specify (never guess).
- Login lowercase-normalized; unlinked-email commits fall back to
  git-email match against recorded emails; `type: Bot` / `[bot]`
  skipped; 250-commit cap handled via paginated fallback.

Webhook legs (`pull_request` opened/synchronize/reopened;
`pull_request.closed` merged; `issue_comment.created`; `installation*`):

1. HMAC-SHA256 over RAW body, constant-time compare.
2. Kernel evaluate → `POST /check-runs` `cla/ribose`:
   success / failure (missing, with personalized links) /
   `action_required` (must-specify, with per-agreement links).
3. One threaded bot comment per PR, updated in place (no spam on
   force-push).
4. On merge: closing comment citing each committer's agreement +
   past-contributions inclusion where elected.
5. `installation_repositories.added` → pre-register a `neutral`
   `cla/ribose` run on each repo's default-branch HEAD (requirable
   immediately).
6. Fail-closed: ANY store/config/GitHub failure ⇒ check FAILURE
   with the honest reason. Never a silent pass.

## 6. Staff vs contractors — resolved in the identity service

**Employment classification is an identity-service attribute**
(org-scoped roles in Ribose ID):

- Identity accounts carry roles distinguishing `staff` from
  `contractor`. Classification data is estate admin work in the
  identity admin console.
- Config maps roles → coverage policy:

  ```yaml
  coverage:
    staff_roles:
      - {org: ribose, role: staff}     # employment-covered
    contractor_policy: sign            # contractors sign/join like externals — explicit, not assumed
  ```

- Enforcement resolution: committer login → GitHub link binding
  (`link` records in the data repo, created whenever anyone links at
  the portal or JIT-creates via GitHub upstream) → identity subject →
  roles. Staff ⇒ covered as staff; **contractor ⇒ NOT
  employment-covered** (must sign or join an OCLA — that is the point
  of the distinction); unlinked login ⇒ no staff path (the bot comment
  tells staff to link once). Fail-closed: unresolvable ⇒ absent,
  never assumed.
- **Identity-service coordination**: a service-token-guarded read
  endpoint on the identity provider —
  `GET /api/service/subject-roles?upstream=github&id=<numeric>` →
  `{account_id, roles[]}` (fail-closed without a service token,
  audited, burst-limited). This is a scoped change in the identity
  service requiring separate approval.

## 7. Config schema (instance repo, gen-compiled)

```yaml
instance: {name: Ribose, portal_host: cla.ribose.com}
identity:  # Ribose ID RP
  issuer: https://id.ribose.com
  client_id: …            # client_secret = Worker secret
  service_token_ref: …    # for subject-roles lookups
legal:
  editions:
    icla: {current: "1.0", files: {"1.0": "legal/icla/1.0.md"}}
    ocla: {current: "1.0", files: {"1.0": "legal/ocla/1.0.md"}}
github:
  app: {slug: ribose-cla}
  data_repo: <private data repo>
  offline_repo: <private offline repo>
  data_installation_id: …     # the installation covering repos 3+4
coverage:
  staff_roles: [{org: ribose, role: staff}]
  allowlist:
    global: [dependabot[bot], github-actions[bot]]
    per_org: {example-org: [example-ci]}
  repos_without_cla: []
  comment_signing: {enabled: false}   # Option B, counsel's call
  notify: {digest_threshold: 10, from: notify.ribose.com}
```

## 8. Data schemas (data repo, append-only, one file per record)

```
icla/{ts}/{id}.json        {ribose_id_sub, github_login, github_id, name, email,
                            email_verified, alt_email?, country, cla_edition,
                            signed_at, source: portal|comment-completed|backfill,
                            past_contributions_included, evidence?}
ocla/{ts}/{id}.json        {ocla_id, org{slug,name,address,country,domains[]},
                            signatory{ribose_id_sub,name,email,title,
                            github_login|null}, poc{name,email,phone},
                            cla_edition, signed_at, source, past_contributions_included,
                            evidence?}
ocla-mod/{ts}/{id}.json    {ocla_id, change: schedule-a delta|poc change,
                            actor_ribose_id_sub, recorded_at}
link/{ts}/{id}.json        {ribose_id_sub, github_login, github_id, linked_at, source}
role/{ts}/{id}.json        {org_admin, ocla_id, ribose_id_sub, granted_at,
                            granted_by, source: enrollment|staff}  (+revoke records)
attribution/{ts}/{id}.json {repo, pr, login, agreement_ref, recorded_at}
revocation/{ts}/{id}.json  {target record, reason, by, at}
```

Evidence pointers: `{repo, path, sha256}` — the kernel treats
missing/mismatched evidence as unsigned + flagged. Branch protection
on repos 3+4: app + staff team write only, no force-push, linear
history. D1: sessions, nonces, pending join requests, burst counters,
audit log, installation-token cache.

## 9. Fail-closed postures (complete list)

unset app key / webhook secret → surfaces closed, checks never pass;
store unreachable → check failure + reason; evidence missing/mismatch
→ unsigned + flagged; roles unresolvable → staff path absent; mail
provider unset → honest 503 (nothing silent); ops token unset →
/admin 404; unlinked staff login → treated as external.

## 10. Testing & gates

Three gates green (`npm run typecheck` / `npm test` / `npm run build`
= wrangler deploy --dry-run). Specs: kernel (pure coverage matrix —
every precedence and edition-staleness case), store adapter (real
migrations over in-memory sqlite), webhook routes via `app.fetch`
(HMAC vector from GitHub docs, fork-PR payload capture), portal legs
(OIDC + GitHub OAuth flows with real app, no doubles of kernel
interfaces), evidence verifier, comment-command parser.

## 11. Backfill & rollout

- **Eager**: import known OCLAs at go-live (first: MTG AG, signed
  2026-03-01, evidence scan → offline repo, Schedule A = TJ-91,
  falko-strenzke — verified rnpgp/rnp contributors;
  `past_contributions_included: true` + note).
- **Lazy**: past ICLA signers re-sign at their next PR via the bot
  comment (30-second flow, current edition, past-contributions
  election included). Evidence-backfill stays available for hold-outs.
- **Rollout stages** (each an owner action with runbook steps):
  1. App registered (riboseinc), secrets set, Worker deployed,
     cla.ribose.com DNS.
  2. Install on orgs (org-wide); pre-registration makes `cla/ribose`
     requirable immediately.
  3. Backfill OCLAs imported.
  4. Branch protection: add `cla/ribose` required check per repo
     (teeth) — repo-by-repo, owner-driven.
  5. CONTRIBUTING.md updates per org point at cla.ribose.com.

## 12. Owner runbook (exact actions — the app never does these)

1. **GitHub App**: create under `riboseinc` — name "Ribose CLA",
   homepage `https://cla.ribose.com`, webhook
   `https://cla.ribose.com/api/github/webhook`, events: pull_request,
   issue_comment, installation, installation_repositories;
   permissions: pull_requests: read, checks: write, contents: read,
   administration: NONE. Note App ID + client_id; generate + download
   the private key; set the webhook secret.
2. **GitHub OAuth App** (identity upstream): callback
   `https://id.ribose.com/api/upstream/github/callback`; then
   `UPSTREAM_GITHUB_CLIENT_ID` into identity vars (PR),
   `UPSTREAM_GITHUB_CLIENT_SECRET` via wrangler secret; deliberate
   deploy; verify JIT sign-in.
3. **Cloudflare**: Worker `ribose-cla`, D1, KV (token cache), secrets
   (app private key, webhook secret, OIDC client secret, service
   token, ops token, mail keys); custom domains cla.ribose.com +
   notify.ribose.com (SPF/DKIM on the subdomain only).
4. **Repos**: create the private instance/data/offline repos (branch
   protection per §8); install the App covering data + offline (that
   installation id → config).
5. **Install App org-wide** on each contributor org.
6. **Identity service**: classify accounts staff vs contractor in
   admin; approve the subject-roles service API change.
7. **Branch protection** per enforcing repo: require `cla/ribose`
   (+ pin source app), keep CI checks.
8. **CONTRIBUTING.md** per org after go-live.

## 13. Open items (counsel / owner, non-blocking for build)

1. Which identity roles count as employment (`staff_roles` list) —
   counsel decides; contractors deliberately excluded.
2. Staff-precedence on attribution overlap: v1 = must-specify like
   everyone; `staff_precedence: always` switch available.
3. Option B (fully-automatic comment signing) — OFF, counsel's call.
4. Coverage by GitHub-org membership (vs named Schedule A rows) —
   not built; counsel's view needed; the OCLA text says designated
   employees by name.
5. Identity provider optional fix: copy upstream-verified emails on
   JIT account creation.
6. v1 org roster (riboseinc pilots; owner curates).
