# How to sign the Ribose CLA

Every external contributor to a Ribose GitHub organization signs the
Individual Contributor License Agreement (ICLA) once. One signature
covers your contributions to all Ribose organizations on GitHub. This
document describes the signing flow; the enforcement App tells you on
a pull request when a signature is needed and links here.

You do not sign if Ribose already holds an agreement with you — staff
and contractors are covered by that agreement, the CLA process does not
apply, and the App and the portal never ask you for a signature. If you
are in doubt, the App's statement on your pull request says which case
applies to you.

## The signing flow

You sign in with your GitHub account. The Ribose ID account — the
identity account that holds the association permanently — is handled
for you in the same pass:

- If you **already have a Ribose ID account**, the **Continue with
  GitHub** step links it to your GitHub handle.
- If you **have never had a Ribose ID account**, the same
  **Continue with GitHub** step **creates one automatically** from
  your GitHub identity. Your verified GitHub email becomes the
  account's verified email. There is no registration form and no
  password to set.

```mermaid
flowchart TD
    A["Open the CLA link on the pull request"] --> B["cla.ribose.com/icla"]
    B --> C["Sign in with GitHub"]
    C --> D{"Ribose ID account already exists?"}
    D -- "yes" --> E["Continue with GitHub — the account links to your handle"]
    D -- "no" --> F["Continue with GitHub — the account is created automatically"]
    E --> G["The ICLA page shows your verified identity"]
    F --> G
    G --> H["Scroll the Agreement, type your full legal name, AGREE"]
    H --> I["Recorded — your pull request turns green on its own"]
```

## Steps, start to finish

1. **Open the link.** On a pull request, the `ribose-cla` App posts a
   comment that names the committer who needs to sign and links to the
   signing page. Open that link in your own browser — the page signs
   whoever is signed in, so the contributor signs in their own session.
2. **Sign in with GitHub.** GitHub asks you to authorize the Ribose CLA
   App. This proves that the handle is yours.
3. **Continue with GitHub on id.ribose.com.** Ribose ID asks you to
   authorize the Ribose ID App. This step either links your existing
   Ribose ID account to your GitHub handle or creates the account for
   you automatically (see above).
4. **Review the Agreement.** The exact text of the current edition
   renders on the page, with its sha256. The page shows your GitHub
   handle and your verified email — the identity the signature binds.
5. **Scroll through the Agreement** and **type your full legal
   name**. The typed name is the signature; the form does not submit
   without it, and the page unlocks the signature line only after the
   end of the Agreement has been on screen.
6. **AGREE.** The signature records append-only, with the edition, the
   exact text hash, and the signing IP address. Your pull request's
   `cla/ribose` check turns green on its own evaluation.
7. **See your record any time** at [cla.ribose.com/agreements](https://cla.ribose.com/agreements) —
   the edition you signed, its hash, and the exact text in a viewer.

## Committing from another email address

GitHub links a commit to your account only when the commit's git author
email belongs to your account. If you commit from a machine configured
with another address, the check cannot tell who you are.

Two answers, in order of preference:

1. **Link the address to GitHub** (Settings → Emails), configure git to
   use it, and push again. Every commit then links automatically.
2. **Verify the address in the portal.** At
   [cla.ribose.com/agreements](https://cla.ribose.com/agreements), under
   **Commit emails**, add the address. A one-time link is mailed to it;
   opening that link in the same signed-in browser records the address.
   Commits carrying it then count as yours — covered by the agreement
   you already signed, with no second signature. An address is only
   recorded after you prove you receive its mail.

## If your pull request is still blocked

The check re-evaluates on the next push. If the check has not caught
up, a maintainer can press **Re-run** on the `cla/ribose` check.

## Organization contributors

If your company has an executed Organization CLA, your employer's
Point of Contact adds your GitHub handle to its Schedule A, which
covers you without an individual signature. You can also request
coverage yourself at [cla.ribose.com/organizations](https://cla.ribose.com/organizations).

## Third-party material

If a contribution includes work that is not your original creation, the
Agreement's third-party clause lets you submit it on behalf of a named
third party. Declare it on the pull request:

```text
@ribose-cla third-party: <name> (SPDX: <license-id>)
```

For example:

```text
@ribose-cla third-party: Example Corp (SPDX: MIT)
```

The SPDX identifier is required, and it must be on Ribose's
accepted-license list. A declaration with a missing or unaccepted license
is refused, and nothing is recorded. When accepted, the App adds the
marking to the pull request description and states the obligations in its
reply. The declaration does not replace your own agreement — your
signature still gates the check.


## Working from the pull request: the commands

The check replies to a pull request's own contributors. Write any of
these as a comment on your pull request:

- `@ribose-cla help` — every command, listed in the thread.
- `@ribose-cla agree` — sign from the pull request: the check posts
  your personal sign link. (Where comment signing is fully-automatic,
  the comment itself is the signature — and it also works on an
  [issue](https://github.com/riboseinc/cla-signatures): comment it on
  the pinned sign-here issue and the App's reply names the exact ICLA
  version. No pull request needed.)
- `@ribose-cla agree icla` — elect the Individual CLA when the check
  asks you to choose an agreement.
- `@ribose-cla agree company=<org>` — elect your organization's CLA
  when you are on its roster; when you are not, it files a join request
  with the organization's Point of Contact.
- `@ribose-cla third-party: <name> (SPDX: <license>)` — declare work
  submitted on behalf of a third party, under a license Ribose accepts
  (the Agreement's third-party clause).
- `@ribose-cla status` — your own coverage, answered live.
- `@ribose-cla recheck` — re-run the check on the current head.

The portal page at `/help` carries the same list.

## Signing from a security advisory

GitHub does not let any integration — including the Ribose CLA App — see
security advisory pages or their temporary private forks. A comment on an
advisory (even an `@ribose-cla` mention) never reaches the App, and the
`cla/ribose` check cannot run on an advisory fork's pull requests. That is
GitHub's platform rule, not a Ribose configuration.

If your only surface is an advisory:

- Sign at [cla.ribose.com/icla](https://cla.ribose.com/icla) — coverage is
  per-person and instance-wide, so the fix lands cleanly when the advisory
  merges.
- Or open a pull request in a Ribose repository you legitimately contribute
  to — for example the [signature venue][cla-signatures] — and comment
  `@ribose-cla agree` there. Never open a public pull request carrying
  details of an unpublished vulnerability.

[cla-signatures]: https://github.com/riboseinc/cla-signatures

## Two ways to sign in

The portal proves your GitHub handle to bind the signature. Two entries:

- **Sign in with GitHub** — the dual verification: authorize the Ribose CLA
  App (proving the handle to the portal), then continue at id.ribose.com.
- **Continue at id.ribose.com** — one standard sign-in through your Ribose
  ID account; when it holds a linked GitHub identity, no App authorization
  screen is shown.
