import type { StaffMap } from "@riboseinc/cla-kernel";
import type { FetchLike } from "../github/api";
import type { LinkRecord } from "../store/records";
import { STAFF_CACHE } from "../cache";

/**
 * Staff/contractor resolution via the IDENTITY SERVICE (docs/design.md
 * §6, issue #10): PR committer login -> LINK record -> identity subject
 * -> `subject-roles` service API -> StaffMap the kernel consumes.
 * Fail-closed everywhere: no service token, an unlinked login, an
 * unresolvable subject, or an API failure all mean NO staff entry —
 * never an assumed pass. Contractor roles (outside config's
 * staff_roles) deliberately fall through to signing.
 */

export type StaffDeps = {
  fetcher: FetchLike;
  issuer: string; // identity service base (from config identity.issuer)
  serviceToken?: string;
};

type RolesDoc = { account_id?: unknown; roles?: unknown };

export async function buildStaffMap(
  deps: StaffDeps,
  logins: string[],
  links: LinkRecord[],
): Promise<{ staffMap: StaffMap; unresolved: string[] }> {
  const staffMap: StaffMap = {};
  const unresolved: string[] = [];
  if (!deps.serviceToken) return { staffMap, unresolved: [...logins] };

  // Bare invocation: a global fetch called as a method is an illegal
  // invocation in Workers.
  const fetcher = deps.fetcher;
  const byLogin = new Map(links.map((l) => [l.githubLogin.toLowerCase(), l] as const));
  for (const raw of logins) {
    const login = raw.toLowerCase();
    const link = byLogin.get(login);
    if (!link) {
      unresolved.push(login);
      continue;
    }
    const cached = STAFF_CACHE.get(`staff:${link.riboseSub}`);
    if (cached) {
      staffMap[login] = cached;
      continue;
    }
    let entry: { org: string; role: string } | null = null;
    try {
      const res = await fetcher(
        `${deps.issuer.replace(/\/$/, "")}/api/service/subject-roles?upstream=github&id=${link.githubId}`,
        { headers: { Authorization: `Bearer ${deps.serviceToken}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
      );
      if (res.status !== 200) {
        unresolved.push(login);
        continue;
      }
      const doc = (await res.json()) as RolesDoc;
      const roles = Array.isArray(doc.roles) ? doc.roles : [];
      const first = roles.find(
        (r) => r !== null && typeof r === "object" && typeof (r as Record<string, unknown>)["org"] === "string" && typeof (r as Record<string, unknown>)["role"] === "string",
      );
      if (first) entry = { org: (first as Record<string, unknown>)["org"] as string, role: (first as Record<string, unknown>)["role"] as string };
    } catch {
      unresolved.push(login);
      continue;
    }
    if (entry) {
      staffMap[login] = entry;
      STAFF_CACHE.put(`staff:${link.riboseSub}`, entry);
    } else {
      unresolved.push(login);
    }
  }
  return { staffMap, unresolved };
}

/** Tests clear the per-isolate role cache between legs (estate reset pattern). */
export const resetStaffCache = (): void => STAFF_CACHE.clear();
