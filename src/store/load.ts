import type { Editions, IclaRecord, OclaRecord, PrVerdict, StoreSnapshot } from "@riboseinc/cla-kernel";
import { evaluate } from "@riboseinc/cla-kernel";
import { foldScheduleA, parseIcla, parseOcla, parseOclaMod, parseRevocation, parseAttribution, parseRole, parseLink, type OclaModRecord, type RoleRecord, type LinkRecord, type OclaFile } from "./records";

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

export type LoadedSnapshot = {
  snapshot: StoreSnapshot;
  /** Records that failed validation — fail-visible, never silent. */
  rejected: { path: string; reason: string }[];
  /** Schedule-A modifications (the console's history view). */
  mods: OclaModRecord[];
  /** org_admin role records (portal authorization). */
  roles: RoleRecord[];
  /** GitHub-handle <-> identity-subject bindings (staff resolution, issue #10). */
  links: LinkRecord[];
  /** ocla id -> PoC email (notify leg). */
  oclaPocs: Record<string, string | undefined>;
  /** The internal roster's latest record (issue #62): a management
   *  grouping only — it never grants coverage. */
  roster?: { recordedAt: string; members: Array<{ login: string; role: string; name: string }> };
  /** The latest separate-agreement registry record: the logins whose
   *  contributions fall under a separate written agreement with Ribose.
   *  The classification stays in the private data repo; nothing public
   *  renders it. */
  msa?: { recordedAt: string; logins: string[] };
};

export async function loadSnapshot(deps: StoreDeps, editions: Editions): Promise<LoadedSnapshot> {
  const { paths, read } = await deps.listRecords();

  const iclas: IclaRecord[] = [];
  const oclas: OclaFile[] = [];
  const modsByOcla = new Map<string, OclaModRecord[]>();
  const mods: OclaModRecord[] = [];
  const roles: RoleRecord[] = [];
  const links: LinkRecord[] = [];
  const revokedIds: string[] = [];
  const attributions: NonNullable<StoreSnapshot["attributions"]> = [];
  const thirdParties: NonNullable<StoreSnapshot["thirdParties"]> = [];
  let roster: { recordedAt: string; members: Array<{ login: string; role: string; name: string }> } | undefined;
  let msa: { recordedAt: string; logins: string[] } | undefined;
  const rejected: { path: string; reason: string }[] = [];

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
      r ? iclas.push(r) : rejected.push({ path, reason: "invalid icla" });
    } else if (path.startsWith("ocla/")) {
      const r = parseOcla(parsed);
      r ? oclas.push(r) : rejected.push({ path, reason: "invalid ocla" });
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
    } else if (path.startsWith("revocation/")) {
      const target = parseRevocation(parsed);
      target ? revokedIds.push(target) : rejected.push({ path, reason: "invalid revocation" });
    } else if (path.startsWith("attribution/")) {
      const r = parseAttribution(parsed);
      r ? attributions.push({ repo: r.repo, pr: r.pr, login: r.login, agreement: r.agreement as NonNullable<StoreSnapshot["attributions"]>[number]["agreement"] }) : rejected.push({ path, reason: "invalid attribution" });
    } else if (path.startsWith("msa/")) {
      const o = parsed as Record<string, unknown>;
      const at = typeof o["recorded_at"] === "string" ? o["recorded_at"] : undefined;
      const loginsRaw = Array.isArray(o["logins"]) ? o["logins"] : [];
      const logins = loginsRaw.map((l) => (typeof l === "string" ? l : "")).filter(Boolean);
      at && logins.length > 0 && (!msa || at > msa.recordedAt) ? (msa = { recordedAt: at, logins }) : rejected.push({ path, reason: "invalid msa" }) && undefined;
    } else if (path.startsWith("roster/")) {
      const o = parsed as Record<string, unknown>;
      const at = typeof o["recorded_at"] === "string" ? o["recorded_at"] : undefined;
      const membersRaw = Array.isArray(o["members"]) ? o["members"] : [];
      const members = membersRaw
        .map((m) => m as Record<string, unknown>)
        .map((m) => ({ login: typeof m["login"] === "string" ? m["login"] : "", role: typeof m["role"] === "string" ? m["role"] : "", name: typeof m["name"] === "string" ? m["name"] : "" }))
        .filter((m) => m.login);
      at && members.length > 0 && (!roster || at > roster.recordedAt) ? (roster = { recordedAt: at, members }) : rejected.push({ path, reason: "invalid roster" }) && undefined;
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
    // link/ and role/ are portal inputs, not kernel inputs
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

  return {
    snapshot: {
      iclas: iclas.filter((r) => !revoked.has(r.id)),
      oclas: effectiveOclas,
      revokedIds, // kernel re-checks; harmless, keeps the revocation fact visible
      attributions,
      thirdParties,
      ...(msa ? { msaLogins: msa.logins } : {}),
    },
    rejected,
    roster,
    msa,
    mods,
    roles: roles.filter((r) => !revoked.has(r.id)),
    links: links.filter((l) => !revoked.has(l.id)),
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
