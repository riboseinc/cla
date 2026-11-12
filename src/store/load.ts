import type { Editions, IclaRecord, OclaRecord, PrVerdict, StoreSnapshot } from "@riboseinc/cla-kernel";
import { evaluate } from "@riboseinc/cla-kernel";
import { foldScheduleA, parseIcla, parseOcla, parseOclaMod, parseRevocation, parseAttribution, type OclaModRecord, type AttributionRecord } from "./records";

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
};

export async function loadSnapshot(deps: StoreDeps, editions: Editions): Promise<LoadedSnapshot> {
  const { paths, read } = await deps.listRecords();

  const iclas: IclaRecord[] = [];
  const oclas: OclaRecord[] = [];
  const modsByOcla = new Map<string, OclaModRecord[]>();
  const revokedIds: string[] = [];
  const attributions: NonNullable<StoreSnapshot["attributions"]> = [];
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
      } else rejected.push({ path, reason: "invalid ocla-mod" });
    } else if (path.startsWith("revocation/")) {
      const target = parseRevocation(parsed);
      target ? revokedIds.push(target) : rejected.push({ path, reason: "invalid revocation" });
    } else if (path.startsWith("attribution/")) {
      const r = parseAttribution(parsed);
      r ? attributions.push({ repo: r.repo, pr: r.pr, login: r.login, agreement: r.agreement as NonNullable<StoreSnapshot["attributions"]>[number]["agreement"] }) : rejected.push({ path, reason: "invalid attribution" });
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
    },
    rejected,
  };
}

/** Convenience: load + evaluate in one call (the webhook leg's happy path). */
export async function loadAndEvaluate(
  deps: StoreDeps,
  editions: Editions,
  args: Parameters<typeof evaluate>[0],
  cfg: Parameters<typeof evaluate>[2],
  staff: Parameters<typeof evaluate>[4],
): Promise<{ loaded: LoadedSnapshot; verdict: PrVerdict }> {
  const loaded = await loadSnapshot(deps, editions);
  const verdict = evaluate(args, loaded.snapshot, cfg, editions, staff);
  return { loaded, verdict };
}
