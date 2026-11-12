/**
 * The pure CLA evaluation kernel. Zero I/O: everything comes in as
 * plain data and everything goes out as plain verdicts. Transport and
 * SQL live strictly above/below this package (docs/design.md §5).
 *
 * Issue #2 fills the evaluation logic; the types below are the seam
 * the rest of the system is already written against.
 */

export const KERNEL_VERSION = "0.1.0";

/** Content-addressed edition identity (docs/design.md §3.6). */
export type ClaEdition = {
  kind: "icla" | "ocla";
  version: string;
  textSha256: string;
};

export type KernelInput = {
  editions: { icla: ClaEdition; ocla: ClaEdition };
};

export const kernelVersion = (): string => KERNEL_VERSION;
