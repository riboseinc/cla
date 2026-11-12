import type { StoreDeps, RecordLister } from "./load";
import type { GithubApi } from "../github/api";

/**
 * The data-repo lister over the GitHub API: ONE recursive tree listing
 * (ETag-cached by the api layer — the common case is a 304, costing
 * nothing against the rate limit), then blob reads per record file.
 */

const RECORD_NAMESPACES = ["icla/", "ocla/", "ocla-mod/", "revocation/"];

export function makeListRecords(api: GithubApi, installationId: number, dataRepo: string): StoreDeps["listRecords"] {
  return async (): Promise<RecordLister> => {
    const tree = await api.request(installationId, "GET", `/repos/${dataRepo}/git/trees/HEAD?recursive=1`, { etagPath: `tree:${dataRepo}:HEAD` });
    if (tree.status !== 200) throw new Error(`data repo tree listing failed: ${tree.status}`);
    const parsed = JSON.parse(tree.body) as { tree?: Array<{ path?: string; type?: string }> };
    const paths = (parsed.tree ?? [])
      .filter((e) => e.type === "blob" && typeof e.path === "string" && e.path.endsWith(".json") && RECORD_NAMESPACES.some((ns) => e.path!.startsWith(ns)))
      .map((e) => e.path!);

    const blobs = new Map<string, string>();
    await Promise.all(
      paths.map(async (p) => {
        const res = await api.request(installationId, "GET", `/repos/${dataRepo}/contents/${p}`);
        if (res.status === 200) {
          const j = JSON.parse(res.body) as { content?: string; encoding?: string };
          blobs.set(p, j.encoding === "base64" ? Buffer.from(j.content ?? "", "base64").toString("utf8") : (j.content ?? ""));
        }
      }),
    );

    return {
      paths,
      read: async (p) => {
        const hit = blobs.get(p);
        if (hit === undefined) throw new Error(`record vanished mid-load: ${p}`);
        return hit;
      },
    };
  };
}
