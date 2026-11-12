# Rollout runbook — owner actions

Every step here is deliberately human-executed; the App never performs
any of it (least privilege: `administration: write` is never requested).
Sequence the stages; do not skip the backfill before the teeth (stage 5).

## Stage 1 — GitHub App registration

1. github.com/organizations/riboseinc/settings/apps → **New GitHub App**:
   - GitHub App name: `Ribose CLA`
   - Homepage URL: `https://cla.ribose.com`
   - Webhook — Active ✓ — URL: `https://cla.ribose.com/api/github/webhook`
   - Webhook secret: generate one (→ Worker secret `WEBHOOK_SECRET`)
   - Permissions:
     - Repository: Pull requests **Read-only**, Contents **Read-only**, Checks **Read & write**
     - Organization: (none required)
     - Administration: **NO ACCESS**
   - Subscribe to events: **Pull request**, **Issue comment**, **Installation**, **Installation repositories**
   - Where can this app be installed: **Any account**
2. Generate a private key (→ `APP_PRIVATE_KEY`), note the **App ID** (→ `GITHUB_APP_ID`) and the **client ID** (→ `GITHUB_APP_CLIENT_ID`).

## Stage 2 — Identity service (Ribose ID)

1. **GitHub upstream**: github.com/settings/developers → New OAuth App — name `Ribose ID`, homepage `https://id.ribose.com`, callback `https://id.ribose.com/api/upstream/github/callback`. Client ID → `UPSTREAM_GITHUB_CLIENT_ID` (vars PR on the identity repo), client secret → `wrangler secret put UPSTREAM_GITHUB_CLIENT_SECRET`. Deliberate deploy; verify the GitHub button on the sign-in page + one JIT sign-in.
2. **Classify accounts**: in the identity `/admin`, assign org roles `staff` vs `contractor` (counsel decides who is which; contractors sign/join like externals).
3. **Service endpoint**: the `GET /api/service/subject-roles` change (issue #10, identity-repo PR) — deploy deliberately; issue the service token (→ `SERVICE_TOKEN` on the CLA Worker).

## Stage 3 — Cloudflare + instance repo

1. Create the private repos under `ribosei`:
   - `cla-instance` (config + `legal/icla/1.0.md`, `legal/ocla/1.0.md` — the counsel texts)
   - `cla-data` (records; branch protection: app + staff write only, **no force-push, linear history**)
   - `cla-offline` (evidence scans, checksummed)
2. `wrangler d1 create cla-ephemeral`; apply migrations (`d1 migrations apply DB --remote`); KV for caches if desired.
3. Worker `ribose-cla` secrets: `APP_PRIVATE_KEY`, `WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SERVICE_TOKEN`, `OPS_TOKEN`, `MAIL_PROVIDER_URL`, `MAIL_PROVIDER_KEY`.
4. Instance repo: copy this repo's `wrangler.example.toml` + `config/cla.example.yaml` shape → real values (org roster, allowlists, `data_installation_id` — see stage 4); real legal texts; deploy deliberately (`wrangler deploy`), never from CI.
5. DNS: `cla.ribose.com` → Worker custom domain; `notify.ribose.com` SPF/DKIM (subdomain only — the corporate mail domain's records stay untouched).

## Stage 4 — Installations

- Install **Ribose CLA** org-wide on `ribosei` FIRST (covers `cla-data` + `cla-offline`) — note the **installation id** → config `github.data_installation_id`.
- Install org-wide on the pilot org, then the rest of the v1 roster. Pre-registration makes `cla/ribose` requirable immediately on every repo.

## Stage 5 — Backfill (MTG AG first)

1. Upload the signed scan to `cla-offline` (e.g. `mtg/2026-03-01-ccla.pdf`); compute `sha256sum`.
2. Staff console: `POST /admin/backfill-ocla` with the evidence pointer + org fields + Schedule A (`tj-91`, `falko-strenzke`), `signed_at: 2026-03-01`, `poc.email` from the document → record lands evidence-verified; open the returned PoC enrollment URL with the PoC (they verify the invited mailbox on their identity account).
3. Other known signed OCLAs: same procedure. ICLA hold-outs: `/admin/backfill-icla`. Everyone else re-signs lazily at their next PR — do nothing.

## Stage 6 — The teeth

- Per enforcing repo: Settings → Branches → branch protection on `main` → **Require status checks** → select `cla/ribose` (it appears because of pre-registration) → pin the source app to **Ribose CLA**.
- Repo by repo, org by org. Admin bypasses remain possible but appear as missing ledger/attribution records — visible.

## Stage 7 — After go-live

- Update each org's CONTRIBUTING.md: signing link `https://cla.ribose.com`, the `@ribose-cla agree` command, and the corporate-CLA path.
- TODO/ledger notes land in this repo's issues only.

## Verification between stages

- `GET https://cla.ribose.com/healthz` answers with the instance name.
- One unsigned PR in the pilot repo → failing check + signing comment; sign via the comment link → check flips to success; merge → closing attribution comment.
