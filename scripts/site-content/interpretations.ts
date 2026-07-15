// -------------------------------------------------------------------------
// Per-experiment interpretation notes
//
// Editorial reading of an experiment's promoted results, kept deliberately
// separate from the computed findings panel so a human's reading of the numbers
// is never confusable with the numbers themselves. Like the explainers, this
// module holds copy only — no clock, no randomness, no I/O — so the site stays
// byte-identical across builds. The "as of" date is a declared field on each
// entry, never read from the clock.
//
// Staleness proofing: every entry declares the run IDs it was written against
// (`coveredRunIds`). At build time the renderer cross-checks this list against
// the promoted runs actually on disk and FAILS the build if a promoted run is
// not covered, so a note can never silently describe a stale slice of the data.
// -------------------------------------------------------------------------

/** Editorial interpretation for one experiment. */
export interface ExperimentInterpretation {
  /**
   * The date this reading was written, as an ISO date string (YYYY-MM-DD).
   * Rendered in the heading; the site never derives it from the clock.
   */
  readonly asOf: string;
  /**
   * The promoted run IDs this note was written against. The build fails if any
   * promoted run of the experiment is missing from this list.
   */
  readonly coveredRunIds: readonly string[];
  /** The interpretation body, as one or more paragraphs. */
  readonly paragraphs: readonly string[];
}

const INTERPRETATIONS: Readonly<Record<string, ExperimentInterpretation>> = {
  "babel-relay": {
    asOf: "2026-07-15",
    coveredRunIds: [
      "20260714T164041956Z-order-20260714",
      "20260714T170651223Z-order-20260714",
      "20260715T070249170Z-order-20260714",
    ],
    paragraphs: [
      "These are exploratory pilots — a consistent signal, not a proven effect. Nothing below is confirmatory.",
      "Across a 12B model and a frontier-class model, baseline drift behavior is capability-resistant: both silently execute drifted definitions in over 90% of baseline drift trials. Supplying full definitions as prose helps (+18 to +27 points) but requires no content addressing, and compact lookup is a wash. Content-addressed references made drift visible in every addressed trial across both pilots — yet visibility alone barely moved task success. Enforcement converted that detection into outcomes (+39 to +45 points over voluntary checking), reaching 93.9% and 98.9% task success respectively, with enforced-arm false halts at 5% and 0.6%.",
      "The preregistered, confirmatory test of these effects has not yet run. Until it has, the strongest supportable claim is that the mechanism decomposition behaves as designed at two very different capability levels.",
    ],
  },
};

/**
 * Return the interpretation content for an experiment, or `undefined` when no
 * copy is registered (callers render nothing in that case).
 */
export function getInterpretation(
  experimentId: string,
): ExperimentInterpretation | undefined {
  return INTERPRETATIONS[experimentId];
}

/**
 * Return the promoted run IDs that are NOT covered by the experiment's
 * interpretation note, in the order they were supplied. An empty array means
 * every promoted run is accounted for. Returns an empty array when the
 * experiment has no registered interpretation (there is nothing to gate).
 */
export function uncoveredRunIds(
  experimentId: string,
  promotedRunIds: readonly string[],
): string[] {
  const interpretation = INTERPRETATIONS[experimentId];
  if (interpretation === undefined) {
    return [];
  }
  const covered = new Set(interpretation.coveredRunIds);
  return promotedRunIds.filter((runId) => !covered.has(runId));
}
