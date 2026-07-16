import type { ResolvedOutcome } from "./schemas.js";

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
