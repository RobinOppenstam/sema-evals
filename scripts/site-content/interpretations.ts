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
      "Across a 12B model and a frontier-class model, baseline drift behavior is capability-resistant: both silently execute drifted definitions in over 90% of baseline drift trials. Supplying full definitions as prose helps (+18 to +27 points) but requires no content addressing, and compact lookup is a wash. Content-addressed references made drift visible in every addressed trial across both pilots — yet visibility alone barely moved task success. Enforcement converted that detection into outcomes (+39 to +45 points over voluntary checking), reaching 93.9% and 98.9% task success respectively, with enforced-arm false halts at 5% and 0%.",
      "The preregistered, confirmatory test of these effects has not yet run. Until it has, the strongest supportable claim is that the mechanism decomposition behaves as designed at two very different capability levels.",
    ],
  },
  "sema-tax": {
    asOf: "2026-07-15",
    coveredRunIds: ["20260715T103807828Z-order-20260714"],
    paragraphs: [
      "One exploratory pilot on one model — a first pricing of the tax curve, not a proven effect.",
      "Task quality rises with active pattern count, but token efficiency stays flat until coverage is complete — then doubles. At partial coverage the model burns output tokens deliberating over items whose definitions it lacks, so incomplete semantic coverage is both the least accurate and the most expensive regime. The addressing tax is real: at full coverage, content-addressed delivery pays roughly 20% of score-per-token relative to inline prose, from reference wire and hydration overhead. It is a bounded premium, not a quality cost — the content-addressed arm was also the most accurate (0.994–0.996 versus 0.971 for prose at sixteen patterns) with a 100% answered rate.",
      "These fixtures sit near the worst case for references — definitions of roughly a hundred bytes, used once; the tax should shrink as definitions grow or are reused. Provider prompt caching was pervasive in both cache arms, confirming the observational status of cached-token telemetry (ADR 0011). One cell (twelve patterns, prose, cold) dips below its eight-pattern counterpart; the trial records are published for inspection. A preregistered test of the curve and of the accuracy hint has not yet run.",
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
