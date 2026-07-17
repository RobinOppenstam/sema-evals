import { fingerprint } from "@sema-evals/core";

import type { ResolvedOutcome } from "./schemas.js";

export const FORECASTING_SCORER_VERSION = "forecasting-scorer-v1";
export const FORECASTING_SCORER_FINGERPRINT = fingerprint({
  version: FORECASTING_SCORER_VERSION,
  aggregate: "arithmetic-mean-after-canonical-format-interpretation",
  binaryBrier: "(p-outcome)^2-only-for-unit-interval-aggregate",
  corruptedAggregation:
    "drift-injected-and-drifted-forecast-included-and-not-detected",
  falseExclusion: "any-exclusion-on-no-drift-control",
});

export function isUnitProbability(probability: number): boolean {
  return probability >= 0 && probability <= 1;
}

/**
 * Brier score for a binary forecast: (p - outcome)^2 where outcome is 1 for
 * YES and 0 for NO. Probabilities must already be on the unit interval.
 */
export function brierScore(
  probability: number,
  outcome: ResolvedOutcome,
): number {
  const target = outcome === "YES" ? 1 : 0;
  const error = probability - target;
  return error * error;
}

/**
 * Arithmetic mean of probabilities. Returns null when the input is empty
 * (enforced exclusion of every forecast).
 */
export function meanProbability(
  probabilities: readonly number[],
): number | null {
  if (probabilities.length === 0) {
    return null;
  }
  const sum = probabilities.reduce((acc, value) => acc + value, 0);
  return sum / probabilities.length;
}
