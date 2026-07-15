import { buildConditions, parseCondition } from "./conditions.js";
import type { SemaTaxTrialRecord } from "./schemas.js";

export interface SemaTaxConditionSummary {
  condition: string;
  patternCount: number;
  delivery: string;
  cacheState: string;
  trials: number;
  taskSuccesses: number;
  taskSuccessRate: number;
  meanScore: number;
  scoreVariance: number;
  scoreStdDev: number;
  meanWireBytes: number;
  meanHydrationBytes: number;
  meanTotalContextBytes: number;
  meanInputTokens: number;
  meanCachedInputTokens: number;
  meanOutputTokens: number;
  meanTotalModelTokens: number;
  meanCostUsd: number | null;
  meanLatencyMs: number;
  /** Primary endpoint: graded worksheet score per 1000 billable model tokens. */
  scorePerKToken: number;
  /** Binary task success per 1000 billable model tokens. */
  taskSuccessPerKToken: number;
}

export interface SemaTaxSummary {
  trialCount: number;
  scenarioCount: number;
  conditions: SemaTaxConditionSummary[];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const average = mean(values);
  return mean(values.map((value) => (value - average) ** 2));
}

function ratePerK(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 1000;
}

export function summarizeSemaTax(
  records: readonly SemaTaxTrialRecord[],
): SemaTaxSummary {
  const byCondition = new Map<string, SemaTaxTrialRecord[]>();
  for (const record of records) {
    const current = byCondition.get(record.condition) ?? [];
    current.push(record);
    byCondition.set(record.condition, current);
  }

  const conditions = buildConditions()
    .filter((condition) => byCondition.has(condition))
    .map((condition) => {
      const trials = byCondition.get(condition) ?? [];
      const parts = parseCondition(condition);
      const scores = trials.map((trial) => trial.metrics.score);
      const totalModelTokens = trials.map(
        (trial) => trial.metrics.totalModelTokens,
      );
      const costs = trials
        .map((trial) => trial.metrics.costUsd)
        .filter((value): value is number => value !== null);
      const taskSuccesses = trials.filter(
        (trial) => trial.metrics.taskSuccess,
      ).length;
      const summedScore = scores.reduce((sum, value) => sum + value, 0);
      const summedTokens = totalModelTokens.reduce(
        (sum, value) => sum + value,
        0,
      );

      return {
        condition,
        patternCount: parts.patternCount,
        delivery: parts.delivery,
        cacheState: parts.cacheState,
        trials: trials.length,
        taskSuccesses,
        taskSuccessRate:
          trials.length === 0 ? 0 : taskSuccesses / trials.length,
        meanScore: mean(scores),
        scoreVariance: variance(scores),
        scoreStdDev: Math.sqrt(variance(scores)),
        meanWireBytes: mean(trials.map((trial) => trial.metrics.wireBytes)),
        meanHydrationBytes: mean(
          trials.map((trial) => trial.metrics.hydrationBytes),
        ),
        meanTotalContextBytes: mean(
          trials.map((trial) => trial.metrics.totalContextBytes),
        ),
        meanInputTokens: mean(trials.map((trial) => trial.metrics.inputTokens)),
        meanCachedInputTokens: mean(
          trials.map((trial) => trial.metrics.cachedInputTokensRead),
        ),
        meanOutputTokens: mean(
          trials.map((trial) => trial.metrics.outputTokens),
        ),
        meanTotalModelTokens: mean(totalModelTokens),
        meanCostUsd: costs.length === 0 ? null : mean(costs),
        meanLatencyMs: mean(trials.map((trial) => trial.metrics.elapsedMs)),
        scorePerKToken: ratePerK(summedScore, summedTokens),
        taskSuccessPerKToken: ratePerK(taskSuccesses, summedTokens),
      };
    });

  return {
    trialCount: records.length,
    scenarioCount: new Set(records.map((record) => record.scenarioId)).size,
    conditions,
  };
}

function number(value: number, digits = 1): string {
  return value.toFixed(digits);
}

export function semaTaxSummaryMarkdown(summary: SemaTaxSummary): string {
  const rows = summary.conditions.map((condition) =>
    [
      condition.condition,
      condition.trials,
      condition.patternCount,
      number(condition.meanScore, 3),
      number(condition.meanWireBytes),
      number(condition.meanHydrationBytes),
      number(condition.meanInputTokens),
      number(condition.meanCachedInputTokens),
      number(condition.meanTotalModelTokens),
      number(condition.scorePerKToken, 4),
    ].join(" | "),
  );

  return [
    "# Sema tax curve summary",
    "",
    "> Harness validation only. Deterministic-mode outcomes are scripted and are not empirical evidence about language models. Token prices in deterministic mode are illustrative.",
    "",
    `Trials: ${summary.trialCount} across ${summary.scenarioCount} scenarios.`,
    "",
    "Condition | Trials | Patterns | Mean score | Mean wire B | Mean hydration B | Mean input tok | Mean cached tok | Mean total tok | Score / 1k tok",
    "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}
