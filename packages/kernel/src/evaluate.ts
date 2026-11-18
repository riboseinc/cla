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
  context: { org: string; repo: string; pr: number };
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
   *  third party; the contributor's own ICLA still gates coverage. */
  thirdParties?: Array<{ repo: string; pr: number; login: string; name: string }>;
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
};

// ---- outputs ----

export type AgreementRef =
  | { kind: "icla"; version: string }
  | { kind: "ocla"; version: string; oclaId: string; orgSlug: string };

export type CommitterVerdict =
  | { login: string | null; status: "covered"; path: "allowlist" | "icla" | "ocla" | "separate-agreement"; agreement?: AgreementRef; matchedBy: "login" | "email"; underSeparateAgreement?: boolean }
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

    // The registry IS the coverage: a login bound to a separate written
    // agreement with Ribose is covered outright — no ICLA click, and
    // the attribution never claims the ICLA (issue #85, owner model).
    // UNLINKED commits (author_login NULL) match by the git author
    // email — the identity the commit actually carries.
    const registryByLogin = c.login !== null && (snap.msaLogins ?? []).map(normalize).includes(normalize(c.login));
    const registryByEmail = c.email !== null && c.email !== undefined && (snap.msaEmails ?? []).map(normalize).includes(normalize(c.email));
    if (registryByLogin || registryByEmail) {
      committers.push({ login: c.login, status: "covered", path: "separate-agreement", matchedBy: registryByLogin ? "login" : "email", underSeparateAgreement: true });
      continue;
    }

    const allowlisted =
      (c.login && (cfg.coverage.allowlist.global.map(normalize).includes(normalize(c.login)) ||
        (cfg.coverage.allowlist.perOrg[pr.context.org] ?? []).map(normalize).includes(normalize(c.login)))) ?? false;
    if (allowlisted) {
      committers.push({ login: c.login, status: "covered", path: "allowlist", matchedBy: "login" });
      continue;
    }

    const paths: { path: "icla" | "ocla"; agreement?: AgreementRef }[] = [];
    let matchedBy: "login" | "email" = "login";
    let resolvedLogin: string | null = c.login;

    if (c.login) {
      paths.push(...collectPaths("login", c.login, snap, editions, revoked));
    }
    if (paths.length === 0 && c.email) {
      paths.push(...collectPaths("email", c.email, snap, editions, revoked));
      matchedBy = "email";
      resolvedLogin = c.login;
    }

    // The registry returned above: a login it binds never reaches here, so
    // an ICLA/OCLA path is never flagged as separate-agreement coverage.
    if (paths.length === 1) {
      const p = paths[0]!;
      committers.push({ login: resolvedLogin, status: "covered", path: p.path, agreement: p.agreement, matchedBy });
    } else if (paths.length > 1) {
      const options = paths.map((p) => p.agreement!).filter(Boolean);
      // A stored election for THIS (repo, pr, login) resolves the ambiguity
      // — but only while the chosen agreement is still among the live paths.
      const chosen = resolvedLogin
        ? (snap.attributions ?? []).find(
            (a) =>
              a.pr === pr.context.pr &&
              normalize(a.repo) === normalize(`${pr.context.org}/${pr.context.repo}`) &&
              normalize(a.login) === normalize(resolvedLogin),
          )
        : undefined;
      const match = chosen ? paths.find((p) => agreementKey(p.agreement!) === agreementKey(chosen.agreement)) : undefined;
      if (match) {
        committers.push({ login: resolvedLogin, status: "covered", path: match.path, agreement: match.agreement, matchedBy });
      } else if (resolvedLogin) {
        committers.push({ login: resolvedLogin, status: "must-specify", options, matchedBy });
        mustSpecify[resolvedLogin] = options;
      } else {
        // Two agreements match an unlinked committer: there is no login to
        // ask, so review cannot resolve it — fail closed instead of passing.
        committers.push({ login: null, status: "missing" });
        missing.push(c.email ? `email:${c.email}` : "unlinked");
      }
    } else {
      committers.push({ login: resolvedLogin, status: "missing" });
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
