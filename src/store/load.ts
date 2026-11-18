import type { Editions, IclaRecord, OclaRecord, PrVerdict, StoreSnapshot } from "@riboseinc/cla-kernel";
import { evaluate } from "@riboseinc/cla-kernel";
import { foldScheduleA, parseIcla, parseOcla, parseOclaMod, parseRevocation, parseAttribution, parseRole, parseLink, parseEmail, type OclaModRecord, type RoleRecord, type LinkRecord, type EmailRecord, type OclaFile } from "./records";

/**
 * The store leg: the data repo's record tree -> a kernel snapshot.
 * The whole snapshot hangs off ONE tree listing (git trees API,
 * recursive) whose ETag makes the common case a 304 — no rate-limit
 * cost (docs/design.md §5).
 */

export type RecordLister = {
  paths: string[];
  read: (path: string) => Promise<string>;
};

export type StoreDeps = {
  /** Lists `*.json` record paths + contents for the data repo at HEAD. */
  listRecords: () => Promise<RecordLister>;
};

export type EditionDivergence = {
  path: string;
  kind: "icla" | "ocla";
  version: string;
  /** The hash the stored record was signed against. */
  recordSha256: string;
  /** The hash this deployment compiled for the same version. */
  currentSha256: string;
};

export type LoadedSnapshot = {
  snapshot: StoreSnapshot;
  /** Records that failed validation — fail-visible, never silent. */
  rejected: { path: string; reason: string }[];
  /** Records that declare the SAME {kind, version} as this deploy's
   *  current edition with a DIFFERENT text hash. Editions are
   *  content-addressed, so a version's text is fixed: the stored record
   *  and the compiled bundle cannot both be right, and every record of
   *  that edition reads as not-live — a covered person as "missing",
   *  which is the false gap of issue #104. Empty is the only healthy
   *  value; the callers above must fail loudly, never blame the person. */
  editionDivergences: EditionDivergence[];
  /** Schedule-A modifications (the console's history view). */
  mods: OclaModRecord[];
  /** org_admin role records (portal authorization). */
  roles: RoleRecord[];
  /** GitHub-handle <-> identity-subject bindings (staff resolution, issue #10). */
  links: LinkRecord[];
  /** Verified commit emails (issue #115), live and deduped per binding. */
  emails: EmailRecord[];
  /** ocla id -> PoC email (notify leg). */
  oclaPocs: Record<string, string | undefined>;
};

export async function loadSnapshot(deps: StoreDeps, editions: Editions): Promise<LoadedSnapshot> {
  const { paths, read } = await deps.listRecords();

  const iclas: IclaRecord[] = [];
  const oclas: OclaFile[] = [];
  const modsByOcla = new Map<string, OclaModRecord[]>();
  const mods: OclaModRecord[] = [];
  const roles: RoleRecord[] = [];
  const links: LinkRecord[] = [];
  const emails: EmailRecord[] = [];
  const revokedIds: string[] = [];
  const attributions: NonNullable<StoreSnapshot["attributions"]> = [];
  const thirdParties: NonNullable<StoreSnapshot["thirdParties"]> = [];
  const rejected: { path: string; reason: string }[] = [];
  const editionDivergences: EditionDivergence[] = [];

  const diverged = (kind: "icla" | "ocla", edition: { version: string; textSha256: string }, path: string): void => {
    const current = editions[kind];
    if (edition.version === current.version && edition.textSha256 !== current.textSha256) {
      editionDivergences.push({ path, kind, version: edition.version, recordSha256: edition.textSha256, currentSha256: current.textSha256 });
    }
  };

  const sorted = [...paths].sort(); // creation order: ts-encoded paths sort correctly
  for (const path of sorted) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await read(path));
    } catch (e) {
      rejected.push({ path, reason: `unparseable: ${(e as Error).message}` });
      continue;
    }
    if (path.startsWith("icla/")) {
      const r = parseIcla(parsed);
      if (r) {
        iclas.push(r);
        diverged("icla", r.edition, path);
      } else rejected.push({ path, reason: "invalid icla" });
    } else if (path.startsWith("ocla/")) {
      const r = parseOcla(parsed);
      if (r) {
        oclas.push(r);
        diverged("ocla", r.edition, path);
      } else rejected.push({ path, reason: "invalid ocla" });
    } else if (path.startsWith("ocla-mod/")) {
      const r = parseOclaMod(parsed);
      if (r) {
        const list = modsByOcla.get(r.oclaId) ?? [];
        list.push(r);
        modsByOcla.set(r.oclaId, list);
        mods.push(r);
      } else rejected.push({ path, reason: "invalid ocla-mod" });
    } else if (path.startsWith("role/")) {
      const r = parseRole(parsed);
      r ? roles.push(r) : rejected.push({ path, reason: "invalid role" });
    } else if (path.startsWith("link/")) {
      const r = parseLink(parsed);
      r ? links.push(r) : rejected.push({ path, reason: "invalid link" });
    } else if (path.startsWith("email/")) {
      const r = parseEmail(parsed);
      r ? emails.push(r) : rejected.push({ path, reason: "invalid email verification" });
    } else if (path.startsWith("revocation/")) {
      const target = parseRevocation(parsed);
      target ? revokedIds.push(target) : rejected.push({ path, reason: "invalid revocation" });
    } else if (path.startsWith("attribution/")) {
      const r = parseAttribution(parsed);
      r ? attributions.push({ repo: r.repo, pr: r.pr, login: r.login, agreement: r.agreement as NonNullable<StoreSnapshot["attributions"]>[number]["agreement"] }) : rejected.push({ path, reason: "invalid attribution" });
    } else if (path.startsWith("third_party/")) {
      const o = parsed as Record<string, unknown>;
      const repo = typeof o["repo"] === "string" ? o["repo"] : undefined;
      const pr = typeof o["pr"] === "number" ? o["pr"] : undefined;
      const login = typeof o["login"] === "string" ? o["login"] : undefined;
      const name = typeof o["name"] === "string" ? o["name"] : undefined;
      repo && pr !== undefined && login && name
        ? thirdParties.push({ repo, pr, login, name })
        : rejected.push({ path, reason: "invalid third-party declaration" });
    }
    // role/ and link/ are portal inputs; email/ is folded into the snapshot.
  }

  const revoked = new Set(revokedIds);
  const effectiveOclas = oclas
    .filter((o) => !revoked.has(o.id))
    .map((o) => ({
      id: o.id,
      orgSlug: o.orgSlug,
      edition: o.edition,
      covered: foldScheduleA(o.covered, modsByOcla.get(o.id) ?? []),
    }));

  // Verified commit emails: revocation retires a binding; duplicates of
  // the same (login, email) collapse latest-wins (the record list is
  // path-sorted = creation order). Different logins claiming one address
  // are NOT deduped away — the kernel reads that as an unresolved
  // conflict and never guesses.
  const norm = (s: string): string => s.trim().toLowerCase();
  const liveEmails = new Map<string, EmailRecord>();
  for (const e of emails) {
    if (revoked.has(e.id)) continue;
    liveEmails.set(`${norm(e.githubLogin)}\n${norm(e.email)}`, e);
  }
  const effectiveEmails = [...liveEmails.values()];

  return {
    snapshot: {
      iclas: iclas.filter((r) => !revoked.has(r.id)),
      oclas: effectiveOclas,
      revokedIds, // kernel re-checks; harmless, keeps the revocation fact visible
      attributions,
      thirdParties,
      verifiedEmails: effectiveEmails.map((e) => ({ login: e.githubLogin, email: e.email })),
    },
    rejected,
    editionDivergences,
    mods,
    roles: roles.filter((r) => !revoked.has(r.id)),
    links: links.filter((l) => !revoked.has(l.id)),
    emails: effectiveEmails,
    oclaPocs: Object.fromEntries(oclas.map((o) => [o.id, o.poc?.email ?? undefined])),
  };
}

/** Convenience: load + evaluate in one call (the webhook leg's happy path). */
export async function loadAndEvaluate(
  deps: StoreDeps,
  editions: Editions,
  args: Parameters<typeof evaluate>[0],
  cfg: Parameters<typeof evaluate>[2],
): Promise<{ loaded: LoadedSnapshot; verdict: PrVerdict }> {
  const loaded = await loadSnapshot(deps, editions);
  const verdict = evaluate(args, loaded.snapshot, cfg, editions);
  return { loaded, verdict };
}
