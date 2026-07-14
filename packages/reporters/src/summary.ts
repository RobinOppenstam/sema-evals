import {
  EXPERIMENT_CONDITIONS,
  type ExperimentCondition,
  type TrialRecord,
} from "@sema-evals/core";

export interface ConditionSummary {
  condition: ExperimentCondition;
  trials: number;
  driftTrials: number;
  detected: number;
  halted: number;
  silentDivergences: number;
  taskSuccesses: number;
  falseHalts: number;
  detectionRate: number;
  silentDivergenceRate: number;
  taskSuccessRate: number;
  meanWireBytes: number;
  meanHydrationBytes: number;
  meanTotalSemanticBytes: number;
}

export interface ExperimentSummary {
  trialCount: number;
  scenarioCount: number;
  conditions: ConditionSummary[];
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

export function summarizeTrials(
  records: readonly TrialRecord[],
): ExperimentSummary {
  const byCondition = new Map<ExperimentCondition, TrialRecord[]>();
  for (const record of records) {
    const current = byCondition.get(record.condition) ?? [];
    current.push(record);
    byCondition.set(record.condition, current);
  }

  return {
    trialCount: records.length,
    scenarioCount: new Set(records.map((record) => record.scenarioId)).size,
    conditions: EXPERIMENT_CONDITIONS.filter((condition) =>
      byCondition.has(condition),
    ).map((condition) => {
      const trials = byCondition.get(condition) ?? [];
      const driftTrials = trials.filter((trial) => trial.metrics.driftInjected);
      const detected = driftTrials.filter(
        (trial) => trial.metrics.driftDetected,
      ).length;
      const silentDivergences = driftTrials.filter(
        (trial) => trial.metrics.silentDivergence,
      ).length;
      const taskSuccesses = trials.filter(
        (trial) => trial.metrics.taskSuccess,
      ).length;

      return {
        condition,
        trials: trials.length,
        driftTrials: driftTrials.length,
        detected,
        halted: trials.filter((trial) => trial.metrics.halted).length,
        silentDivergences,
        taskSuccesses,
        falseHalts: trials.filter((trial) => trial.metrics.falseHalt).length,
        detectionRate: rate(detected, driftTrials.length),
        silentDivergenceRate: rate(silentDivergences, driftTrials.length),
        taskSuccessRate: rate(taskSuccesses, trials.length),
        meanWireBytes: mean(trials.map((trial) => trial.metrics.wireBytes)),
        meanHydrationBytes: mean(
          trials.map((trial) => trial.metrics.hydrationBytes),
        ),
        meanTotalSemanticBytes: mean(
          trials.map((trial) => trial.metrics.totalSemanticBytes),
        ),
      };
    }),
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function number(value: number): string {
  return value.toFixed(1);
}

export function summaryMarkdown(summary: ExperimentSummary): string {
  const rows = summary.conditions.map((condition) =>
    [
      condition.condition,
      condition.trials,
      percent(condition.detectionRate),
      percent(condition.silentDivergenceRate),
      percent(condition.taskSuccessRate),
      condition.falseHalts,
      number(condition.meanWireBytes),
      number(condition.meanHydrationBytes),
      number(condition.meanTotalSemanticBytes),
    ].join(" | "),
  );

  return [
    "# Babel Relay summary",
    "",
    "> Harness validation only. These deterministic outcomes are not empirical evidence that Sema improves model performance.",
    "",
    `Trials: ${summary.trialCount} across ${summary.scenarioCount} scenarios.`,
    "",
    "Condition | Trials | Detection | Silent divergence | Task success | False halts | Mean wire B | Mean hydration B | Mean semantic B",
    "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}
