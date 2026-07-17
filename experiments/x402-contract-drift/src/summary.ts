import { buildConditions } from "./conditions.js";
import type { X402DriftCondition, X402DriftTrialRecord } from "./schemas.js";

export const X402_DRIFT_SCORER_VERSION = "x402-contract-drift-scorer-v2";

export interface X402DriftConditionSummary {
  condition: X402DriftCondition;
  trials: number;
  driftTrials: number;
  cleanTrials: number;
  detected: number;
  halted: number;
  paid: number;
  silentPayments: number;
  correctHalts: number;
  falseHalts: number;
  taskSuccesses: number;
  /** Over drift trials. */
  detectionRate: number;
  /** Primary endpoint, over drift trials. */
  silentPaymentRate: number;
  /** Over clean (no-drift) trials — the false-refusal guard. */
  falseHaltRate: number;
  taskSuccessRate: number;
  meanWireBytes: number;
  meanHydrationBytes: number;
  meanTotalSemanticBytes: number;
}

export interface X402DriftSummary {
  trialCount: number;
  scenarioCount: number;
  driftScenarioCount: number;
  cleanScenarioCount: number;
  conditions: X402DriftConditionSummary[];
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

export function summarizeX402Drift(
  records: readonly X402DriftTrialRecord[],
): X402DriftSummary {
  const byCondition = new Map<X402DriftCondition, X402DriftTrialRecord[]>();
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

  const conditions = buildConditions()
    .filter((condition) => byCondition.has(condition))
    .map((condition): X402DriftConditionSummary => {
      const trials = byCondition.get(condition) ?? [];
      const driftTrials = trials.filter((trial) => trial.metrics.driftInjected);
      const cleanTrials = trials.filter(
        (trial) => !trial.metrics.driftInjected,
      );
      const detected = driftTrials.filter(
        (trial) => trial.metrics.driftDetected,
      ).length;
      const silentPayments = driftTrials.filter(
        (trial) => trial.metrics.silentPayment,
      ).length;
      const correctHalts = trials.filter(
        (trial) => trial.metrics.correctHalt,
      ).length;
      const falseHalts = trials.filter(
        (trial) => trial.metrics.falseHalt,
      ).length;
      const taskSuccesses = trials.filter(
        (trial) => trial.metrics.taskSuccess,
      ).length;

      return {
        condition,
        trials: trials.length,
        driftTrials: driftTrials.length,
        cleanTrials: cleanTrials.length,
        detected,
        halted: trials.filter((trial) => trial.metrics.halted).length,
        paid: trials.filter((trial) => trial.metrics.paid).length,
        silentPayments,
        correctHalts,
        falseHalts,
        taskSuccesses,
        detectionRate: rate(detected, driftTrials.length),
        silentPaymentRate: rate(silentPayments, driftTrials.length),
        falseHaltRate: rate(falseHalts, cleanTrials.length),
        taskSuccessRate: rate(taskSuccesses, trials.length),
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
    conditions,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function number(value: number): string {
  return value.toFixed(1);
}

export function x402DriftSummaryMarkdown(summary: X402DriftSummary): string {
  const rows = summary.conditions.map((condition) =>
    [
      condition.condition,
      condition.trials,
      condition.driftTrials,
      percent(condition.detectionRate),
      percent(condition.silentPaymentRate),
      condition.correctHalts,
      condition.falseHalts,
      percent(condition.falseHaltRate),
      percent(condition.taskSuccessRate),
      number(condition.meanWireBytes),
      number(condition.meanHydrationBytes),
    ].join(" | "),
  );

  return [
    "# x402 payment-contract drift summary",
    "",
    "> Harness validation only. These deterministic, scripted-agent outcomes are a construction, not empirical evidence about language models, and not conformance evidence against a real x402 SDK (see ADR 0016).",
    "",
    `Trials: ${summary.trialCount} across ${summary.scenarioCount} scenarios (${summary.driftScenarioCount} drift, ${summary.cleanScenarioCount} no-drift).`,
    "",
    "Primary endpoint: silent payment under cross-party registry drift (payer pays using its drifted definition with no surfaced mismatch). Secondary: false refusals on no-drift trials.",
    "",
    "Condition | Trials | Drift trials | Detection | Silent pay | Correct refusals | False refusals | False-refusal rate | Task success | Mean wire B | Mean hydration B",
    "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}
