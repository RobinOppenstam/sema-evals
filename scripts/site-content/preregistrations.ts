// -------------------------------------------------------------------------
// Registered preregistrations
//
// The site needs to know a confirmatory experiment's *full* registered design
// — every model arm named in the preregistration — so it can report an honest
// cross-arm verdict: "confirmed" only once every registered arm is published,
// and "N of M registered arms published — verdict pending" until then. That
// registered arm list lives in the document (prereg 001 §6), not in any single
// bundle, so it is declared here as site content, exactly like the interpretation
// coverage gate. This module holds copy and constants only — no clock, no
// randomness, no I/O — so the site stays byte-identical across builds.
//
// Each entry is keyed by the preregistration document digest, which every
// confirmatory bundle records in provenance. The `registeredCommit` pins the
// commit whose blob of `path` hashes to `digest`, so the site can link to the
// exact registered document (the registration merge commit itself).
// -------------------------------------------------------------------------

/** A registered preregistration and the arms fixed in it. */
export interface RegisteredPreregistration {
  /** Short identifier, e.g. "prereg-001". */
  readonly id: string;
  /** The experiment this preregistration governs. */
  readonly experimentId: string;
  /** Repo-relative path of the preregistration markdown. */
  readonly path: string;
  /** SHA-256 of the registered document bytes (matches bundle provenance). */
  readonly digest: string;
  /** Commit at which `path` hashes to `digest` (the registration merge commit). */
  readonly registeredCommit: string;
  /**
   * Every model arm fixed in the preregistration (§6), by full model name. The
   * cross-arm verdict is "verdict pending" until all of these are published.
   */
  readonly registeredArms: readonly string[];
}

const PREREGISTRATIONS: readonly RegisteredPreregistration[] = [
  {
    id: "prereg-001",
    experimentId: "babel-relay",
    path: "docs/preregistrations/prereg-001-babel-relay-confirmatory.md",
    digest: "40be2c73dbec9beb8f46ab27d6b56c53c94c4372cca2d1647e235e6085fb46b7",
    registeredCommit: "e83e10377d74620f854627d641e047537110a992",
    // Prereg 001 §6 — the three model arms of the same registered design.
    registeredArms: [
      "unsloth/Mistral-Nemo-Instruct-2407-TEE",
      "MiniMaxAI/MiniMax-M2.5-TEE",
      "Qwen/Qwen3-32B-TEE",
    ],
  },
];

/**
 * Return the registered preregistration whose document digest matches, or
 * `undefined` when none is registered (callers then render nothing
 * confirmatory-specific). The digest is the join key every confirmatory bundle
 * carries in `provenance.preregistrationDigest`.
 */
export function getPreregistrationByDigest(
  digest: string | undefined,
): RegisteredPreregistration | undefined {
  if (digest === undefined) {
    return undefined;
  }
  return PREREGISTRATIONS.find((entry) => entry.digest === digest);
}
