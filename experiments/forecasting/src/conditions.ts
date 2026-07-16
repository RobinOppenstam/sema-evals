import {
  FORECASTING_CONDITIONS,
  type ForecastingCondition,
} from "./schemas.js";

/**
 * The three conditions of the forecasting council demo:
 *
 * - `baseline`: coordination terms named by handle only; aggregation proceeds
 *   blindly (raw mean of reported numbers). Nothing can detect definitional
 *   drift — this is the corrupted-aggregation failure mode.
 * - `addressed-voluntary`: forecast objects carry content-addressed references;
 *   the aggregator verifies digests and surfaces mismatches but still
 *   aggregates ALL forecasts (after per-agent format normalization). Isolates
 *   *voluntary detection*.
 * - `addressed-enforced`: identical wire, but the aggregator refuses to include
 *   any forecast whose coordination references mismatch; aggregates the aligned
 *   subset and records exclusion with a typed reason. Isolates *enforced
 *   exclusion*.
 *
 * The no-drift controls (scenarios whose `drift` is null) run under all three
 * conditions too, so the false-exclusion guard is measured on the same blocks.
 */
export interface ForecastingConditionPolicy {
  /** Forecast objects carry content-addressed references. */
  carriesReferences: boolean;
  /** The aggregator verifies cited references against the canonical vocabulary. */
  verifies: boolean;
  /** The aggregator excludes mismatched forecasts (fail-closed). */
  enforces: boolean;
}

export const FORECASTING_CONDITION_POLICIES: Record<
  ForecastingCondition,
  ForecastingConditionPolicy
> = {
  baseline: {
    carriesReferences: false,
    verifies: false,
    enforces: false,
  },
  "addressed-voluntary": {
    carriesReferences: true,
    verifies: true,
    enforces: false,
  },
  "addressed-enforced": {
    carriesReferences: true,
    verifies: true,
    enforces: true,
  },
};

/** The canonical, ordered condition enumeration. `planPairedMatrix` shuffles
 * execution order per the order seed; this only fixes reporting order. */
export function buildConditions(): ForecastingCondition[] {
  return [...FORECASTING_CONDITIONS];
}

export function conditionPolicy(
  condition: ForecastingCondition,
): ForecastingConditionPolicy {
  return FORECASTING_CONDITION_POLICIES[condition];
}
