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
  modelTrials: number;
  modelFailures: number;
  providerFailures: number;
  malformedDecisions: number;
  modelFailureRate: number;
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
  meanInputTokens: number;
  meanCachedInputTokens: number;
  meanOutputTokens: number;
  meanTotalModelTokens: number;
  meanAttempts: number;
  totalRetries: number;
  totalProviderErrors: number;
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
      const modelTrials = trials.filter((trial) => trial.usage !== null);
      const providerFailures = modelTrials.filter(
        (trial) =>
          trial.modelCompletionStatus !== null &&
          trial.modelCompletionStatus !== "completed",
      ).length;
      const malformedDecisions = modelTrials.filter(
        (trial) =>
          trial.modelCompletionStatus === "completed" &&
          trial.modelDecision === "malformed",
      ).length;
      const modelFailures = providerFailures + malformedDecisions;

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
        modelTrials: modelTrials.length,
        modelFailures,
        providerFailures,
        malformedDecisions,
        modelFailureRate: rate(modelFailures, modelTrials.length),
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
        meanInputTokens: mean(
          modelTrials.map((trial) => trial.usage?.inputTokens ?? 0),
        ),
        meanCachedInputTokens: mean(
          modelTrials.map((trial) => trial.usage?.cachedInputTokensRead ?? 0),
        ),
        meanOutputTokens: mean(
          modelTrials.map((trial) => trial.usage?.outputTokens ?? 0),
        ),
        meanTotalModelTokens: mean(
          modelTrials.map(
            (trial) =>
              (trial.usage?.inputTokens ?? 0) +
              (trial.usage?.outputTokens ?? 0),
          ),
        ),
        meanAttempts: mean(
          modelTrials.map((trial) => trial.usage?.attempts ?? 0),
        ),
        totalRetries: modelTrials.reduce(
          (sum, trial) => sum + (trial.usage?.retries ?? 0),
          0,
        ),
        totalProviderErrors: modelTrials.reduce(
          (sum, trial) => sum + (trial.usage?.errors.length ?? 0),
          0,
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

export type A2aDriftSummaryMode =
  "deterministic-harness" | "model-pilot" | "confirmatory";

export function a2aDriftSummaryMarkdown(
  summary: A2aDriftSummary,
  mode: A2aDriftSummaryMode = "deterministic-harness",
): string {
  const isModelRun = mode !== "deterministic-harness";
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
      ...(isModelRun
        ? [
            condition.modelFailures,
            percent(condition.modelFailureRate),
            number(condition.meanInputTokens),
            number(condition.meanCachedInputTokens),
            number(condition.meanOutputTokens),
            number(condition.meanTotalModelTokens),
            condition.totalRetries,
            condition.totalProviderErrors,
          ]
        : []),
    ].join(" | "),
  );

  const caveat = isModelRun
    ? "> Exploratory model-run results. The worker was model-driven; requester, transport, registries, drift injection, verification, and enforcement remained deterministic. Provider failures and malformed terminal decisions are retained as failed trials and never count as silent execution."
    : "> Harness validation only. These deterministic, scripted-agent outcomes are a construction, not empirical evidence about language models, and not conformance evidence against a real A2A SDK (see ADR 0012).";
  const tableHeader = isModelRun
    ? "Condition | Trials | Drift trials | Detection | Silent exec | Correct halts | False halts | False-halt rate | Task success | Mean wire B | Mean hydration B | Model failures | Failure rate | Mean input tok | Mean cached tok | Mean output tok | Mean total tok | Retries | Provider errors"
    : "Condition | Trials | Drift trials | Detection | Silent exec | Correct halts | False halts | False-halt rate | Task success | Mean wire B | Mean hydration B";
  const tableAlignment = isModelRun
    ? "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:"
    : "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:";

  return [
    "# A2A semantic-extension drift summary",
    "",
    caveat,
    "",
    `Trials: ${summary.trialCount} across ${summary.scenarioCount} scenarios (${summary.driftScenarioCount} drift, ${summary.cleanScenarioCount} no-drift).`,
    "",
    "Primary endpoint: silent execution under cross-agent registry drift (worker completes using its drifted definition with no surfaced mismatch). Secondary: false halts on no-drift trials.",
    "",
    tableHeader,
    tableAlignment,
    ...rows,
    "",
  ].join("\n");
}
