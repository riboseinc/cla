import { describe, expect, it } from "vitest";
import { evaluate, type Config, type Editions, type IclaRecord, type PrInput, type StoreSnapshot } from "@riboseinc/cla-kernel";
import { checkRunBody, commentBody, closingComment } from "../src/enforcement/checks";
import { CURRENT_EDITIONS } from "./helpers";

/**
 * An unlinked committer is named by the commit's AUTHOR EMAIL (owner
 * correction, #113). "unlinked" is a fake handle: it tells the contributor
 * nothing, identifies nothing, and cannot be matched to an account.
 *
 * The verdicts below come from the real kernel — no hand-built shapes, so
 * the kernel carrying the email on every variant is part of what is asserted.
 */

const EDITIONS: Editions = {
  icla: { kind: "icla", version: CURRENT_EDITIONS.icla.version, textSha256: CURRENT_EDITIONS.icla.sha256 },
  ocla: { kind: "ocla", version: CURRENT_EDITIONS.ocla.version, textSha256: CURRENT_EDITIONS.ocla.sha256 },
};
const PORTAL = "https://cla.example.org";

const config = (): Config => ({ coverage: { allowlist: { global: [], perOrg: {} } } });

const snapshot = (over: Partial<StoreSnapshot> = {}): StoreSnapshot => ({
  iclas: [],
  oclas: [],
  revokedIds: [],
  ...over,
});

const pr = (committers: PrInput["committers"]): PrInput => ({ context: { org: "rnpgp", repo: "rnp", pr: 1 }, committers });

const FALLBACK = "unlinked@example.com";

const allText = (verdict: ReturnType<typeof evaluate>): string =>
  [
    JSON.stringify(checkRunBody(verdict, PORTAL).output),
    commentBody(verdict, PORTAL),
    closingComment(verdict, {}),
  ].join("\n");

describe("unlinked committers are named by their author email (#113)", () => {
  it("covered by an ICLA through the email match: every surface names the email", () => {
    const verdict = evaluate(
      pr([{ login: null, email: FALLBACK }]),
      snapshot({ iclas: [{ id: "icla-1", githubLogin: "not-this-one", email: FALLBACK, edition: EDITIONS.icla } satisfies IclaRecord] }),
      config(),
      EDITIONS,
    );
    expect(verdict.committers[0]).toMatchObject({ status: "covered", path: "icla", matchedBy: "email", email: FALLBACK });

    const summary = JSON.stringify(checkRunBody(verdict, PORTAL).output);
    expect(summary).toContain(`author email ${FALLBACK} — covered via **icla**`);
    expect(commentBody(verdict, PORTAL)).toContain(`| author email ${FALLBACK} | covered (icla) |`);
    expect(closingComment(verdict, {})).toContain(`- author email ${FALLBACK} — contributed under **the Individual CLA`);
  });

  it("covered by the separate-agreement registry through the email match: named, neutral, no classification", () => {
    const verdict = evaluate(
      pr([{ login: null, email: FALLBACK }]),
      snapshot({ msaLogins: ["someone"], msaEmails: [FALLBACK] }),
      config(),
      EDITIONS,
    );
    const closing = closingComment(verdict, {});
    expect(closing).toContain(`author email ${FALLBACK} — this work is submitted under an existing Ribose agreement; the CLA process does not apply.`);
    expect(closing).not.toContain("staff");
    expect(closing).not.toContain("contractor");
  });

  it("missing with an author email: the teaching row names the email it must fix", () => {
    const verdict = evaluate(pr([{ login: null, email: FALLBACK }]), snapshot(), config(), EDITIONS);
    expect(verdict.committers[0]).toMatchObject({ status: "missing", email: FALLBACK });

    const summary = JSON.stringify(checkRunBody(verdict, PORTAL).output);
    expect(summary).toContain(`author email ${FALLBACK} — the commit's author email is not linked to any GitHub account`);
    expect(commentBody(verdict, PORTAL)).toContain(`| author email ${FALLBACK} | Your commit's author email is not linked to any GitHub account.`);
    expect(closingComment(verdict, {})).toContain(`author email ${FALLBACK} — **merged without CLA coverage**`);
  });

  it("missing with NO author email at all: said plainly, never invented", () => {
    const verdict = evaluate(pr([{ login: null, email: null }]), snapshot(), config(), EDITIONS);
    const summary = JSON.stringify(checkRunBody(verdict, PORTAL).output);
    expect(summary).toContain("an unlinked commit with no author email — **not covered**");
    expect(commentBody(verdict, PORTAL)).toContain("| an unlinked commit with no author email |");
    expect(allText(verdict)).not.toContain("null");
  });

  it("two agreements matching an unlinked committer fail closed — and still name the email", () => {
    // No login can be asked to choose, so the verdict is missing; the email
    // is what the maintainer has to go on.
    const verdict = evaluate(
      pr([{ login: null, email: FALLBACK }]),
      snapshot({
        iclas: [{ id: "icla-1", githubLogin: FALLBACK, email: FALLBACK, edition: EDITIONS.icla }],
        oclas: [
          {
            id: "ocla-1",
            orgSlug: "mtg-ag",
            covered: [{ githubLogin: "tj-91", email: FALLBACK }],
            edition: EDITIONS.ocla,
          },
        ],
      }),
      config(),
      EDITIONS,
    );
    expect(verdict.committers[0]).toMatchObject({ status: "missing", email: FALLBACK });
    expect(allText(verdict)).toContain(FALLBACK);
  });

  it("no surface ever invents a handle for an unlinked committer", () => {
    const cases = [
      evaluate(pr([{ login: null, email: FALLBACK }]), snapshot(), config(), EDITIONS),
      evaluate(pr([{ login: null, email: null }]), snapshot(), config(), EDITIONS),
      evaluate(
        pr([{ login: null, email: FALLBACK }]),
        snapshot({ iclas: [{ id: "icla-1", githubLogin: FALLBACK, email: FALLBACK, edition: EDITIONS.icla }] }),
        config(),
        EDITIONS,
      ),
      evaluate(pr([{ login: null, email: FALLBACK }]), snapshot({ msaEmails: [FALLBACK] }), config(), EDITIONS),
    ];
    for (const verdict of cases) {
      const text = allText(verdict);
      expect(text).not.toContain("@(unlinked)");
      expect(text).not.toContain("(unlinked)");
      expect(text).not.toContain("(unlinked,");
    }
  });
});
