import type { ClaEdition } from "./index";

/**
 * The pure CLA evaluation kernel (docs/design.md §5). Zero I/O: every
 * input is plain data, every output is a plain verdict. The webhook
 * leg resolves store snapshots into the shapes below; this module owns
 * the LEGAL logic and nothing else. The signature is the coverage: one
 * clicked ICLA (or an OCLA roster row) covers every organization.
 */

// ---- inputs ----

export type Committer = {
  /** GitHub login as it appeared on the commit (case normalized internally). */
  login: string | null;
  /** git author email — the fallback matcher for unlinked commits. */
  email?: string | null;
  /** Bot accounts are excluded upstream; the kernel defends anyway. */
  isBot?: boolean;
};

export type PrInput = {
  /** `pr` is absent when the commits landed on the default branch
   *  outside any pull request (advisory merges, VCS-bridge pushes):
   *  the same coverage evaluation, with no PR-scoped attribution
   *  election to consult. */
  context: { org: string; repo: string; pr?: number };
  committers: Committer[];
  /** The PR's size (files changed, additions+deletions) — the
   *  proportionality control's input; the caller resolves it. */
  diff?: { files: number; codeLines: number };
};

export type Editions = { icla: ClaEdition; ocla: ClaEdition };

export type Config = {
  coverage: {
    allowlist: { global: string[]; perOrg: Record<string, string[]> };
    /** The proportionality control (issue #58): a PR under BOTH
     *  thresholds skips CLA enforcement. OFF when absent. */
    minimalChange?: { files: number; codeLines: number };
    /** Coverage by GitHub-org membership (issue #16 item 4): a GitHub
     *  org login -> the OCLA slug whose Schedule A it DESIGNATES for —
     *  the GitHub-org alternative to a named row. Keys are normalized
     *  lowercase at parse. OFF when absent (the default), and never
     *  coverage by itself: the mapped OCLA must be live, or there is
     *  nothing to designate under. */
    orgMembership?: Record<string, string>;
  };
};

export type IclaRecord = {
  id: string;
  githubLogin: string;
  email?: string | null;
  edition: ClaEdition;
};

export type OclaCoveredRow = {
  githubLogin: string;
  email?: string | null;
};

export type OclaRecord = {
  id: string;
  orgSlug: string;
  /** The EFFECTIVE Schedule A: original rows + modifications already folded in order (store leg, issue #3). */
  covered: OclaCoveredRow[];
  edition: ClaEdition;
};

export type StoreSnapshot = {
  iclas: IclaRecord[];
  oclas: OclaRecord[];
  /** Record ids killed by revocation/voidance — coverage reads as if they never existed. */
  revokedIds: string[];
  /** Per-PR agreement elections: a stored choice resolves must-specify (docs/design.md §3.11). */
  attributions?: Array<{ repo: string; pr: number; login: string; agreement: AgreementRef }>;
  /** Clause-7 declarations: the work is submitted on behalf of a named
   *  third party; the contributor's own ICLA still gates coverage. The
   *  SPDX id is the license gate's record (issue #118); declarations
   *  recorded before the gate existed carry none. */
  thirdParties?: Array<{ repo: string; pr: number; login: string; name: string; spdx?: string }>;
  /** Logins whose contributions fall under a separate written agreement
   *  with Ribose (the registry lives in the private data repo; the
   *  classification stays there and is never rendered publicly). The
   *  click still gates; the ATTRIBUTION differs. */
  msaLogins?: string[];
  /** Known commit emails of registry logins: UNLINKED commits (GitHub
   *  cannot resolve the git author email to an account) carry no login,
   *  so the registry must also match on the email the contributor
   *  actually commits with. */
  msaEmails?: string[];
  /** Verified commit emails (issue #115): an address the login proved
   *  through the portal. An UNLINKED commit carrying one is that login's
   *  commit; the normal coverage paths then decide — the verified email
   *  is identity, never coverage by itself. */
  verifiedEmails?: Array<{ login: string; email: string }>;
  /** GitHub-org memberships the transport resolved for the committers
   *  that would otherwise be uncovered (issue #16 item 4): plain facts
   *  (login is a member of org), never fetched by this kernel. The
   *  config's orgMembership map turns a membership into DESIGNATION
   *  under that org's live OCLA — the OCLA signature remains the
   *  coverage; membership only says who it covers. */
  orgMembers?: Array<{ login: string; org: string }>;
};

// ---- outputs ----

export type AgreementRef =
  | { kind: "icla"; version: string }
  | { kind: "ocla"; version: string; oclaId: string; orgSlug: string };

export type CommitterVerdict =
  | { login: string | null; status: "covered"; path: "allowlist" | "icla" | "ocla" | "separate-agreement"; agreement?: AgreementRef; matchedBy: "login" | "email"; underSeparateAgreement?: boolean; viaOrgMembership?: boolean; email?: string | null }
  | { login: string | null; status: "must-specify"; options: AgreementRef[]; matchedBy: "login" | "email" }
  | { login: string | null; status: "missing"; email?: string | null };

export type PrVerdict = {
  /** "pass": every committer covered or must-specify; "fail": at least one missing. */
  verdict: "pass" | "fail";
  committers: CommitterVerdict[];
  missing: string[];
  mustSpecify: Record<string, AgreementRef[]>;
  /** The proportionality control fired: the PR is under both
   *  thresholds and CLA was not enforced. The check summary and the
   *  closing statement must disclose this — never a silent pass. */
  minimalChange?: boolean;
};

// ---- evaluation ----

const normalize = (s: string): string => s.trim().toLowerCase();

const sameEdition = (a: ClaEdition, b: ClaEdition): boolean =>
  a.textSha256 === b.textSha256;

const isLive = (r: { id: string; edition: ClaEdition }, current: ClaEdition, revoked: Set<string>): boolean =>
  !revoked.has(r.id) && sameEdition(r.edition, current);

const iclaRef = (r: IclaRecord): AgreementRef => ({ kind: "icla", version: r.edition.version });
const oclaRef = (r: OclaRecord): AgreementRef => ({
  kind: "ocla",
  version: r.edition.version,
  oclaId: r.id,
  orgSlug: r.orgSlug,
});

/** The login a verified commit email binds. Exactly one login may claim
 *  an address; several claims are an unresolved identity conflict and
 *  resolve to nobody — never guess whose commit it was. */
function verifiedLoginForEmail(snap: StoreSnapshot, email: string): string | undefined {
  const v = normalize(email);
  const hits = (snap.verifiedEmails ?? []).filter((b) => normalize(b.email) === v);
  const logins = new Set(hits.map((b) => normalize(b.login)));
  return logins.size === 1 ? hits[0]!.login : undefined;
}

/** Collect every applicable human-path coverage for one identity string. */
function collectPaths(
  key: "login" | "email",
  value: string,
  snap: StoreSnapshot,
  editions: Editions,
  revoked: Set<string>,
): { path: "icla" | "ocla"; agreement?: AgreementRef }[] {
  const v = normalize(value);
  const out: { path: "icla" | "ocla"; agreement?: AgreementRef }[] = [];

  for (const r of snap.iclas) {
    if (!isLive(r, editions.icla, revoked)) continue;
    const hit = key === "login" ? normalize(r.githubLogin) === v : normalize(r.email ?? "") === v;
    if (hit) out.push({ path: "icla", agreement: iclaRef(r) });
  }
  for (const o of snap.oclas) {
    if (!isLive(o, editions.ocla, revoked)) continue;
    const hit = o.covered.some((row) =>
      key === "login" ? normalize(row.githubLogin) === v : normalize(row.email ?? "") === v,
    );
    if (hit) out.push({ path: "ocla", agreement: oclaRef(o) });
  }
  return out;
}

/** Coverage by GitHub-org membership (issue #16 item 4): the transport
 *  resolved which CONFIGURED GitHub orgs this identity is a member of;
 *  a membership DESIGNATES the identity under that org's live OCLA —
 *  the GitHub-org alternative to a named Schedule A row. The signature
 *  remains the coverage: a stale or revoked OCLA designates nobody,
 *  and without the config map or the resolved facts this returns
 *  nothing. Consulted by evaluate() only when no signature matched. */
function collectMembershipPaths(
  identity: string,
  snap: StoreSnapshot,
  cfg: Config,
  editions: Editions,
  revoked: Set<string>,
): { path: "ocla"; agreement?: AgreementRef; viaOrgMembership?: boolean }[] {
  const map = cfg.coverage.orgMembership;
  if (!map || !snap.orgMembers?.length) return [];
  const out: { path: "ocla"; agreement?: AgreementRef; viaOrgMembership?: boolean }[] = [];
  for (const m of snap.orgMembers) {
    if (normalize(m.login) !== normalize(identity)) continue;
    const slug = Object.entries(map).find(([org]) => normalize(org) === normalize(m.org))?.[1];
    if (!slug) continue;
    const o = snap.oclas.find((r) => normalize(r.orgSlug) === normalize(slug) && isLive(r, editions.ocla, revoked));
    if (!o) continue;
    out.push({ path: "ocla", agreement: oclaRef(o), viaOrgMembership: true });
  }
  return out;
}

export function evaluate(pr: PrInput, snap: StoreSnapshot, cfg: Config, editions: Editions): PrVerdict {
  // The proportionality control runs before coverage evaluation: a PR
  // under BOTH thresholds skips enforcement, visibly (issue #58).
  const mc = cfg.coverage.minimalChange;
  if (
    mc &&
    pr.diff &&
    pr.diff.files <= mc.files &&
    pr.diff.codeLines <= mc.codeLines
  ) {
    return { verdict: "pass", committers: [], missing: [], mustSpecify: {}, minimalChange: true };
  }

  const revoked = new Set(snap.revokedIds);
  const committers: CommitterVerdict[] = [];
  const missing: string[] = [];
  const mustSpecify: Record<string, AgreementRef[]> = {};

  for (const c of pr.committers) {
    if (c.isBot) continue;

    // Identity first: a linked commit carries its login; an UNLINKED one
    // is that login's commit when its author email was verified through
    // the portal (issue #115). The verified email only resolves WHO the
    // commit belongs to — coverage still has to come from a signature.
    const verifiedLogin = c.login === null && c.email ? verifiedLoginForEmail(snap, c.email) : undefined;
    const identity = c.login ?? verifiedLogin ?? null;
    /** The commit itself carried a GitHub login (not just a verified email). */
    const byLogin = c.login !== null;

    // The registry IS the coverage: a login bound to a separate written
    // agreement with Ribose is covered outright — no ICLA click, and
    // the attribution never claims the ICLA (issue #85, owner model).
    // UNLINKED commits (author_login NULL) match by the git author
    // email — the identity the commit actually carries.
    const registryByLogin = identity !== null && (snap.msaLogins ?? []).map(normalize).includes(normalize(identity));
    const registryByEmail = c.email !== null && c.email !== undefined && (snap.msaEmails ?? []).map(normalize).includes(normalize(c.email));
    if (registryByLogin || registryByEmail) {
      const byEmail = registryByLogin ? !byLogin : true;
      committers.push({ login: identity, status: "covered", path: "separate-agreement", matchedBy: byEmail ? "email" : "login", underSeparateAgreement: true, ...(c.email && byEmail ? { email: c.email } : {}) });
      continue;
    }

    const allowlisted =
      (identity && (cfg.coverage.allowlist.global.map(normalize).includes(normalize(identity)) ||
        (cfg.coverage.allowlist.perOrg[pr.context.org] ?? []).map(normalize).includes(normalize(identity)))) ?? false;
    if (allowlisted) {
      committers.push({ login: identity, status: "covered", path: "allowlist", matchedBy: byLogin ? "login" : "email" });
      continue;
    }

    const paths: { path: "icla" | "ocla"; agreement?: AgreementRef; viaOrgMembership?: boolean }[] = [];
    let matchedBy: "login" | "email" = byLogin ? "login" : "email";
    const resolvedLogin = identity;

    if (identity) {
      paths.push(...collectPaths("login", identity, snap, editions, revoked));
    }
    if (paths.length === 0 && c.email) {
      paths.push(...collectPaths("email", c.email, snap, editions, revoked));
      matchedBy = "email";
    }
    // GitHub-org membership is the FALLBACK of last resort (issue #16
    // item 4): consulted only when no signature path matched, so an
    // ICLA or a named Schedule A row is never ambiguous with it. Two
    // mapped orgs -> two OCLAs -> must-specify, like any two paths.
    if (paths.length === 0 && identity) {
      const memberPaths = collectMembershipPaths(identity, snap, cfg, editions, revoked);
      if (memberPaths.length > 0) {
        // The membership fact is keyed by login: an unlinked commit only
        // reaches it through its verified email, so say so.
        matchedBy = byLogin ? "login" : "email";
        paths.push(...memberPaths);
      }
    }

    // Duplicate live records of the SAME agreement (a double-POST race in
    // the sign flow wrote two records one second apart, rnpgp/rnp#2573)
    // must never read as ambiguity: fold the paths by agreement key —
    // ICLAs collapse to one, an OCLA keeps its record id — so a single
    // key after folding is coverage, not a question.
    const folded: typeof paths = [];
    const seenKeys = new Set<string>();
    for (const p of paths) {
      const key = agreementKey(p.agreement!);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        folded.push(p);
      }
    }

    // The registry returned above: a login it binds never reaches here, so
    // an ICLA/OCLA path is never flagged as separate-agreement coverage.
    if (folded.length === 1) {
      const p = folded[0]!;
      committers.push({ login: resolvedLogin, status: "covered", path: p.path, agreement: p.agreement, matchedBy, ...(p.viaOrgMembership ? { viaOrgMembership: true } : {}), ...(c.email && matchedBy === "email" ? { email: c.email } : {}) });
    } else if (folded.length > 1) {
      const options = folded.map((p) => p.agreement!).filter(Boolean);
      // A stored election for THIS (repo, pr, login) resolves the ambiguity
      // — but only while the chosen agreement is still among the live paths.
      const chosen = resolvedLogin
        ? (snap.attributions ?? []).find(
            (a) =>
              pr.context.pr !== undefined &&
              a.pr === pr.context.pr &&
              normalize(a.repo) === normalize(`${pr.context.org}/${pr.context.repo}`) &&
              normalize(a.login) === normalize(resolvedLogin),
          )
        : undefined;
      const match = chosen ? folded.find((p) => agreementKey(p.agreement!) === agreementKey(chosen.agreement)) : undefined;
      if (match) {
        committers.push({ login: resolvedLogin, status: "covered", path: match.path, agreement: match.agreement, matchedBy, ...(match.viaOrgMembership ? { viaOrgMembership: true } : {}), ...(c.email && matchedBy === "email" ? { email: c.email } : {}) });
      } else if (resolvedLogin) {
        committers.push({ login: resolvedLogin, status: "must-specify", options, matchedBy });
        mustSpecify[resolvedLogin] = options;
      } else {
        // Two agreements match an unlinked committer: there is no login to
        // ask, so review cannot resolve it — fail closed instead of passing.
        committers.push({ login: null, status: "missing", ...(c.email ? { email: c.email } : {}) });
        missing.push(c.email ? `email:${c.email}` : "unlinked");
      }
    } else {
      committers.push({ login: resolvedLogin, status: "missing", ...(c.email && !resolvedLogin ? { email: c.email } : {}) });
      // An email-only committer is still a committer: GitHub could not link
      // the commit to an account, and that must fail closed — the verdict is
      // derived from `missing`, so a null login must not drop out of it.
      missing.push(resolvedLogin ?? (c.email ? `email:${c.email}` : "unlinked"));
    }
  }

  return { verdict: missing.length > 0 ? "fail" : "pass", committers, missing, mustSpecify };
}

const agreementKey = (a: AgreementRef): string =>
  a.kind === "ocla" ? `ocla:${a.oclaId}` : "icla";
