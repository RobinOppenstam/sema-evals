import { buildConditions } from "./conditions.js";
import { evaluateLeakageAuditGateFromScenarios } from "./leakage.js";
import type {
  ForecastingCondition,
  ForecastingScenario,
  ForecastingTrialRecord,
} from "./schemas.js";
import { brierScore, isUnitProbability, meanProbability } from "./scoring.js";

export interface ForecastingConditionSummary {
  condition: ForecastingCondition;
  trials: number;
  driftTrials: number;
  cleanTrials: number;
  detected: number;
  corruptedAggregations: number;
  correctExclusions: number;
  falseExclusions: number;
  /** Over drift trials. */
  detectionRate: number;
  /** Primary endpoint, over drift trials. */
  corruptedAggregationRate: number;
  /** Over clean (no-drift) trials — the false-exclusion guard. */
  falseExclusionRate: number;
  meanBrierAggregate: number | null;
  meanBrierMarketPrior: number;
  meanBrierIndependentAverage: number | null;
  /** Model calls that failed or did not produce an objective forecast. */
  modelFailureCount: number;
  meanWireBytes: number;
  meanHydrationBytes: number;
  meanTotalSemanticBytes: number;
}

export interface ForecastingSummary {
  trialCount: number;
  scenarioCount: number;
  driftScenarioCount: number;
  cleanScenarioCount: number;
  leakageAuditPassed: boolean;
  leakageAuditFailures: string[];
  modelDriven: boolean;
  conditions: ForecastingConditionSummary[];
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) {
    return null;
  }
  return mean(present);
}

/**
 * Recomputes Brier scores from a trial's recorded aggregate / baselines and
 * outcome. Used by tests to assert the summary's Brier values recompute from
 * raw records.
 */
export function recomputeTrialBriers(record: ForecastingTrialRecord): {
  brierAggregate: number | null;
  brierMarketPrior: number;
  brierIndependentAverage: number | null;
} {
  const outcome = record.metrics.outcome;
  return {
    brierAggregate:
      record.metrics.aggregateProbability === null ||
      !isUnitProbability(record.metrics.aggregateProbability)
        ? null
        : brierScore(record.metrics.aggregateProbability, outcome),
    brierMarketPrior: brierScore(record.metrics.marketPrior, outcome),
    brierIndependentAverage:
      record.metrics.independentAverage === null
        ? null
        : brierScore(record.metrics.independentAverage, outcome),
  };
}

export function summarizeForecasting(
  records: readonly ForecastingTrialRecord[],
  scenarios?: readonly ForecastingScenario[],
): ForecastingSummary {
  const byCondition = new Map<ForecastingCondition, ForecastingTrialRecord[]>();
  for (const record of records) {
    const current = byCondition.get(record.condition) ?? [];
    current.push(record);
    byCondition.set(record.condition, current);
  }

  const scenarioIds = new Set(records.map((record) => record.scenarioId));
  const driftScenarioIds = new Set(
    records
      .filter((record) => record.driftInjected)
      .map((record) => record.scenarioId),
  );

  // Leakage gate: prefer explicit scenario list; otherwise reconstruct unique
  // question audits from trial records (one audit per scenarioId).
  let leakageAuditPassed = true;
  let leakageAuditFailures: string[] = [];
  if (scenarios) {
    const gate = evaluateLeakageAuditGateFromScenarios(scenarios);
    leakageAuditPassed = gate.passed;
    leakageAuditFailures = gate.failures;
  } else {
    const seen = new Map<string, ForecastingTrialRecord>();
    for (const record of records) {
      if (!seen.has(record.scenarioId)) {
        seen.set(record.scenarioId, record);
      }
    }
    const failures: string[] = [];
    for (const [scenarioId, record] of seen) {
      if (!record.leakageAudit) {
        failures.push(`${scenarioId}: missing leakage audit entry`);
      } else if (record.leakageAudit.verdict !== "keep") {
        failures.push(
          `${scenarioId}: leakage audit verdict is ${record.leakageAudit.verdict}, expected keep`,
        );
      }
    }
    leakageAuditPassed = failures.length === 0;
    leakageAuditFailures = failures;
  }

  const conditions = buildConditions()
    .filter((condition) => byCondition.has(condition))
    .map((condition): ForecastingConditionSummary => {
      const trials = byCondition.get(condition) ?? [];
      const driftTrials = trials.filter((trial) => trial.metrics.driftInjected);
      const cleanTrials = trials.filter(
        (trial) => !trial.metrics.driftInjected,
      );
      const detected = driftTrials.filter(
        (trial) => trial.metrics.driftDetected,
      ).length;
      const corruptedAggregations = driftTrials.filter(
        (trial) => trial.metrics.corruptedAggregation,
      ).length;
      const correctExclusions = trials.filter(
        (trial) => trial.metrics.correctExclusion,
      ).length;
      const falseExclusions = trials.filter(
        (trial) => trial.metrics.falseExclusion,
      ).length;

      return {
        condition,
        trials: trials.length,
        driftTrials: driftTrials.length,
        cleanTrials: cleanTrials.length,
        detected,
        corruptedAggregations,
        correctExclusions,
        falseExclusions,
        detectionRate: rate(detected, driftTrials.length),
        corruptedAggregationRate: rate(
          corruptedAggregations,
          driftTrials.length,
        ),
        falseExclusionRate: rate(falseExclusions, cleanTrials.length),
        meanBrierAggregate: meanNullable(
          trials.map((trial) => trial.metrics.brierAggregate),
        ),
        meanBrierMarketPrior: mean(
          trials.map((trial) => trial.metrics.brierMarketPrior),
        ),
        meanBrierIndependentAverage: meanNullable(
          trials.map((trial) => trial.metrics.brierIndependentAverage),
        ),
        modelFailureCount: trials.reduce(
          (count, trial) =>
            count +
            trial.events.filter((event) => {
              if (event.type !== "message") return false;
              const status = event.details.modelStatus;
              return (
                typeof status === "string" &&
                (status !== "completed" || event.details.parseFailure !== null)
              );
            }).length,
          0,
        ),
        meanWireBytes: mean(trials.map((trial) => trial.metrics.wireBytes)),
        meanHydrationBytes: mean(
          trials.map((trial) => trial.metrics.hydrationBytes),
        ),
        meanTotalSemanticBytes: mean(
          trials.map((trial) => trial.metrics.totalSemanticBytes),
        ),
      };
    });

  return {
    trialCount: records.length,
    scenarioCount: scenarioIds.size,
    driftScenarioCount: driftScenarioIds.size,
    cleanScenarioCount: scenarioIds.size - driftScenarioIds.size,
    leakageAuditPassed,
    leakageAuditFailures,
    modelDriven: records.some((record) => record.usage !== null),
    conditions,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function number(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

export function forecastingSummaryMarkdown(
  summary: ForecastingSummary,
): string {
  const rows = summary.conditions.map((condition) =>
    [
      condition.condition,
      condition.trials,
      condition.driftTrials,
      percent(condition.detectionRate),
      percent(condition.corruptedAggregationRate),
      condition.correctExclusions,
      condition.falseExclusions,
      percent(condition.falseExclusionRate),
      number(condition.meanBrierAggregate),
      number(condition.meanBrierMarketPrior),
      number(condition.meanBrierIndependentAverage),
      condition.modelFailureCount,
    ].join(" | "),
  );

  return [
    "# Forecasting council summary",
    "",
    summary.modelDriven
      ? "> Exploratory model pilot. Not preregistered or confirmatory evidence. Objective parsing and deterministic scoring are used; no LLM judge is used."
      : "> Harness validation only. These deterministic, scripted-agent outcomes are a construction, not empirical evidence about language models, and not evidence about live prediction markets (see ADR 0017).",
    "",
    `Trials: ${summary.trialCount} across ${summary.scenarioCount} scenarios (${summary.driftScenarioCount} drift, ${summary.cleanScenarioCount} no-drift).`,
    "",
    `Leakage audit gate: ${summary.leakageAuditPassed ? "PASSED" : "FAILED"}${summary.leakageAuditFailures.length > 0 ? ` — ${summary.leakageAuditFailures.join("; ")}` : ""}.`,
    "",
    "Primary endpoint: corrupted aggregation under coordination-term drift (drifted forecast entered the aggregate with no surfaced mismatch). Secondary: false exclusions on no-drift trials. Brier scores recorded for council aggregate, market prior, and independent-agent average.",
    "",
    "Condition | Trials | Drift trials | Detection | Corrupted agg | Correct exclusions | False exclusions | False-excl rate | Mean Brier agg | Mean Brier market | Mean Brier indep | Model failures",
    "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}

/** Exported for tests that assert meanProbability is used consistently. */
export { meanProbability };
