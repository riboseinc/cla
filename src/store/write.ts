import type { GithubApi } from "../github/api";

/**
 * Append-only record writing: one commit per record into the data
 * repo (docs/design.md §8). Corrections are NEW records — existing
 * files are never rewritten.
 */

export type WriteDeps = {
  api: GithubApi;
  installationId: number;
  dataRepo: string;
  now: () => number;
  /** injectable id source (specs assert determinism); crypto UUID at runtime */
  newId?: () => string;
};

export async function appendRecord(deps: WriteDeps, namespace: string, record: Record<string, unknown>): Promise<{ path: string; commitSha: string }> {
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  const d = new Date(deps.now());
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const path = `${namespace}/${yyyy}/${mm}/${id}.json`;
  const body = {
    message: `record: ${namespace}/${id}`,
    content: Buffer.from(JSON.stringify(record, null, 2), "utf8").toString("base64"),
  };
  const res = await deps.api.request(deps.installationId, "PUT", `/repos/${deps.dataRepo}/contents/${path}`, { body });
  if (res.status !== 201) throw new Error(`record write failed (${namespace}): ${res.status}`);
  const doc = JSON.parse(res.body) as { commit?: { sha?: string } };
  return { path, commitSha: doc.commit?.sha ?? "unknown" };
}
