// -------------------------------------------------------------------------
// Sema-tax recompute + summary cross-check
//
// The site never trusts a bundle's stored `summary.json`. It re-runs the
// experiment's own summarizer (`summarizeSemaTax`) over the public trial
// derivative and cross-checks the result against the committed summary, exactly
// as the babel-relay path does with `compareWithSummary`. Any disagreement is a
// build failure — a summary can never silently describe a different slice of the
// trials than the ones published.
// -------------------------------------------------------------------------

import {
  summarizeSemaTax,
  type SemaTaxConditionSummary,
  type SemaTaxSummary,
} from "../../experiments/sema-tax/src/summary.js";
import type { SemaTaxTrialRecord } from "../../experiments/sema-tax/src/schemas.js";

export { summarizeSemaTax };
export type { SemaTaxSummary, SemaTaxConditionSummary };

/** Loose shape of a committed sema-tax `summary.json`, kept partial so a schema
 *  drift surfaces as a mismatch rather than a hard parse failure. */
export interface SemaTaxSummaryConditionLike {
  condition?: string;
  patternCount?: number;
  trials?: number;
  taskSuccesses?: number;
  meanScore?: number;
  meanAnsweredRate?: number;
  meanWireBytes?: number;
  meanHydrationBytes?: number;
  meanInputTokens?: number;
  meanCachedInputTokens?: number;
  meanTotalModelTokens?: number;
  scorePerKToken?: number;
}

export interface SemaTaxSummaryLike {
  trialCount?: number;
  scenarioCount?: number;
  conditions?: SemaTaxSummaryConditionLike[];
}

const FLOAT_EPSILON = 1e-6;

/**
 * Recompute the sema-tax summary from trial records and compare it against a
 * bundle's committed `summary.json`. Returns human-readable mismatch messages;
 * an empty list means the summary is faithful to the published trials.
 */
export function compareSemaTaxSummary(
  aggregate: SemaTaxSummary,
  summary: SemaTaxSummaryLike,
): string[] {
  const warnings: string[] = [];

  if (
    summary.trialCount !== undefined &&
    summary.trialCount !== aggregate.trialCount
  ) {
    warnings.push(
      `trialCount: summary=${summary.trialCount} recomputed=${aggregate.trialCount}`,
    );
  }
  if (
    summary.scenarioCount !== undefined &&
    summary.scenarioCount !== aggregate.scenarioCount
  ) {
    warnings.push(
      `scenarioCount: summary=${summary.scenarioCount} recomputed=${aggregate.scenarioCount}`,
    );
  }

  if (!Array.isArray(summary.conditions)) {
    return warnings;
  }

  const byCondition = new Map<string, SemaTaxSummaryConditionLike>();
  for (const condition of summary.conditions) {
    if (condition.condition !== undefined) {
      byCondition.set(condition.condition, condition);
    }
  }

  for (const computed of aggregate.conditions) {
    const reported = byCondition.get(computed.condition);
    if (reported === undefined) {
      warnings.push(`${computed.condition}: missing from summary.json`);
      continue;
    }
    const intChecks: [string, number | undefined, number][] = [
      ["patternCount", reported.patternCount, computed.patternCount],
      ["trials", reported.trials, computed.trials],
      ["taskSuccesses", reported.taskSuccesses, computed.taskSuccesses],
    ];
    for (const [field, reportedValue, computedValue] of intChecks) {
      if (reportedValue !== undefined && reportedValue !== computedValue) {
        warnings.push(
          `${computed.condition}.${field}: summary=${reportedValue} recomputed=${computedValue}`,
        );
      }
    }
    const floatChecks: [string, number | undefined, number][] = [
      ["meanScore", reported.meanScore, computed.meanScore],
      [
        "meanAnsweredRate",
        reported.meanAnsweredRate,
        computed.meanAnsweredRate,
      ],
      ["meanWireBytes", reported.meanWireBytes, computed.meanWireBytes],
      [
        "meanHydrationBytes",
        reported.meanHydrationBytes,
        computed.meanHydrationBytes,
      ],
      ["meanInputTokens", reported.meanInputTokens, computed.meanInputTokens],
      [
        "meanCachedInputTokens",
        reported.meanCachedInputTokens,
        computed.meanCachedInputTokens,
      ],
      [
        "meanTotalModelTokens",
        reported.meanTotalModelTokens,
        computed.meanTotalModelTokens,
      ],
      ["scorePerKToken", reported.scorePerKToken, computed.scorePerKToken],
    ];
    for (const [field, reportedValue, computedValue] of floatChecks) {
      if (
        reportedValue !== undefined &&
        Math.abs(reportedValue - computedValue) > FLOAT_EPSILON
      ) {
        warnings.push(
          `${computed.condition}.${field}: summary=${reportedValue} recomputed=${computedValue}`,
        );
      }
    }
  }

  return warnings;
}

/** Recompute the sema-tax summary directly from trial records. */
export function aggregateSemaTax(
  records: readonly SemaTaxTrialRecord[],
): SemaTaxSummary {
  return summarizeSemaTax(records);
}
