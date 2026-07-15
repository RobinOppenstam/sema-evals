import { buildConditions } from "./conditions.js";
import type { A2aDriftCondition, A2aDriftTrialRecord } from "./schemas.js";

export interface A2aDriftConditionSummary {
  condition: A2aDriftCondition;
  trials: number;
  driftTrials: number;
  cleanTrials: number;
  detected: number;
  halted: number;
  silentExecutions: number;
  correctHalts: number;
  falseHalts: number;
  taskSuccesses: number;
  /** Over drift trials. */
  detectionRate: number;
  /** Primary endpoint, over drift trials. */
  silentExecutionRate: number;
  /** Over clean (no-drift) trials — the false-halt guard. */
  falseHaltRate: number;
  taskSuccessRate: number;
  meanWireBytes: number;
  meanHydrationBytes: number;
  meanTotalSemanticBytes: number;
}

export interface A2aDriftSummary {
  trialCount: number;
  scenarioCount: number;
  driftScenarioCount: number;
  cleanScenarioCount: number;
  conditions: A2aDriftConditionSummary[];
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

export function summarizeA2aDrift(
  records: readonly A2aDriftTrialRecord[],
): A2aDriftSummary {
  const byCondition = new Map<A2aDriftCondition, A2aDriftTrialRecord[]>();
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
    .map((condition): A2aDriftConditionSummary => {
      const trials = byCondition.get(condition) ?? [];
      const driftTrials = trials.filter((trial) => trial.metrics.driftInjected);
      const cleanTrials = trials.filter(
        (trial) => !trial.metrics.driftInjected,
      );
      const detected = driftTrials.filter(
        (trial) => trial.metrics.driftDetected,
      ).length;
      const silentExecutions = driftTrials.filter(
        (trial) => trial.metrics.silentExecution,
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
        silentExecutions,
        correctHalts,
        falseHalts,
        taskSuccesses,
        detectionRate: rate(detected, driftTrials.length),
        silentExecutionRate: rate(silentExecutions, driftTrials.length),
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

export function a2aDriftSummaryMarkdown(summary: A2aDriftSummary): string {
  const rows = summary.conditions.map((condition) =>
    [
      condition.condition,
      condition.trials,
      condition.driftTrials,
      percent(condition.detectionRate),
      percent(condition.silentExecutionRate),
      condition.correctHalts,
      condition.falseHalts,
      percent(condition.falseHaltRate),
      percent(condition.taskSuccessRate),
      number(condition.meanWireBytes),
      number(condition.meanHydrationBytes),
    ].join(" | "),
  );

  return [
    "# A2A semantic-extension drift summary",
    "",
    "> Harness validation only. These deterministic, scripted-agent outcomes are a construction, not empirical evidence about language models, and not conformance evidence against a real A2A SDK (see ADR 0012).",
    "",
    `Trials: ${summary.trialCount} across ${summary.scenarioCount} scenarios (${summary.driftScenarioCount} drift, ${summary.cleanScenarioCount} no-drift).`,
    "",
    "Primary endpoint: silent execution under cross-agent registry drift (worker completes using its drifted definition with no surfaced mismatch). Secondary: false halts on no-drift trials.",
    "",
    "Condition | Trials | Drift trials | Detection | Silent exec | Correct halts | False halts | False-halt rate | Task success | Mean wire B | Mean hydration B",
    "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}
