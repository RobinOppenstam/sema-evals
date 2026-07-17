import { buildConditions } from "./conditions.js";
import type {
  WorkflowValueCondition,
  WorkflowValueTrialRecord,
} from "./schemas.js";

export interface WorkflowConditionSummary {
  condition: WorkflowValueCondition;
  trials: number;
  devTrials: number;
  evalTrials: number;
  evalSuccessesWithinBudget: number;
  /** Primary endpoint, evaluated on the held-out eval split only. */
  evalSuccessWithinBudgetRate: number;
  /** Paired eval success difference from task-only on shared task/seed blocks. */
  pairedEvalDifferenceFromTaskOnly: number;
  validationPassRate: number;
  parseFailureRate: number;
  overBudgetRate: number;
  repairAppliedRate: number;
  meanWireBytes: number;
  meanHydrationBytes: number;
  meanInputTokens: number;
  meanCachedInputTokens: number;
  meanReasoningTokens: number | null;
  meanOutputTokens: number;
  meanTotalModelTokens: number;
  meanTokensToFirstPassingSolution: number | null;
  meanFailedEditTestCycles: number;
  meanRegressions: number;
  meanReworkCycles: number;
  meanLatencyMs: number;
  totalRetries: number;
  totalProviderErrors: number;
}

export interface WorkflowValueSummary {
  trialCount: number;
  devTaskCount: number;
  evalTaskCount: number;
  tokenBudget: number;
  conditions: WorkflowConditionSummary[];
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function blockKey(record: WorkflowValueTrialRecord): string {
  return `${record.scenarioId}::${record.seed}`;
}

export function summarizeWorkflowValue(
  records: readonly WorkflowValueTrialRecord[],
): WorkflowValueSummary {
  const byCondition = new Map<
    WorkflowValueCondition,
    WorkflowValueTrialRecord[]
  >();
  for (const record of records) {
    const current = byCondition.get(record.condition) ?? [];
    current.push(record);
    byCondition.set(record.condition, current);
  }
  const evalTaskIds = new Set(
    records
      .filter((record) => record.split === "eval")
      .map((record) => record.taskId),
  );
  const devTaskIds = new Set(
    records
      .filter((record) => record.split === "dev")
      .map((record) => record.taskId),
  );
  const taskOnlyEval = new Map(
    (byCondition.get("task-only") ?? [])
      .filter((record) => record.split === "eval")
      .map((record) => [blockKey(record), record.metrics.successWithinBudget]),
  );

  const conditions = buildConditions()
    .filter((condition) => byCondition.has(condition))
    .map((condition): WorkflowConditionSummary => {
      const trials = byCondition.get(condition) ?? [];
      const evalTrials = trials.filter((record) => record.split === "eval");
      const devTrials = trials.filter((record) => record.split === "dev");
      const evalSuccessesWithinBudget = evalTrials.filter(
        (record) => record.metrics.successWithinBudget,
      ).length;
      const pairedDifferences = evalTrials
        .map((record) => {
          const baseline = taskOnlyEval.get(blockKey(record));
          return baseline === undefined
            ? null
            : Number(record.metrics.successWithinBudget) - Number(baseline);
        })
        .filter((value): value is number => value !== null);
      const reasoningTokens = trials
        .map((record) => record.metrics.reasoningTokens)
        .filter((value): value is number => value !== null);
      const tokensToFirstPass = trials
        .map((record) => record.metrics.tokensToFirstPassingSolution)
        .filter((value): value is number => value !== null);

      return {
        condition,
        trials: trials.length,
        devTrials: devTrials.length,
        evalTrials: evalTrials.length,
        evalSuccessesWithinBudget,
        evalSuccessWithinBudgetRate: rate(
          evalSuccessesWithinBudget,
          evalTrials.length,
        ),
        pairedEvalDifferenceFromTaskOnly: mean(pairedDifferences),
        validationPassRate: rate(
          trials.filter((record) => record.metrics.validationPassed).length,
          trials.length,
        ),
        parseFailureRate: rate(
          trials.filter((record) => record.metrics.parseFailure).length,
          trials.length,
        ),
        overBudgetRate: rate(
          trials.filter((record) => !record.metrics.withinTokenBudget).length,
          trials.length,
        ),
        repairAppliedRate: rate(
          trials.filter((record) => record.metrics.repairApplied).length,
          trials.length,
        ),
        meanWireBytes: mean(trials.map((record) => record.metrics.wireBytes)),
        meanHydrationBytes: mean(
          trials.map((record) => record.metrics.hydrationBytes),
        ),
        meanInputTokens: mean(
          trials.map((record) => record.metrics.inputTokens),
        ),
        meanCachedInputTokens: mean(
          trials.map((record) => record.metrics.cachedInputTokensRead),
        ),
        meanReasoningTokens:
          reasoningTokens.length === 0 ? null : mean(reasoningTokens),
        meanOutputTokens: mean(
          trials.map((record) => record.metrics.outputTokens),
        ),
        meanTotalModelTokens: mean(
          trials.map((record) => record.metrics.totalModelTokens),
        ),
        meanTokensToFirstPassingSolution:
          tokensToFirstPass.length === 0 ? null : mean(tokensToFirstPass),
        meanFailedEditTestCycles: mean(
          trials.map((record) => record.metrics.failedEditTestCycles),
        ),
        meanRegressions: mean(
          trials.map((record) => record.metrics.regressions),
        ),
        meanReworkCycles: mean(
          trials.map((record) => record.metrics.reworkCycles),
        ),
        meanLatencyMs: mean(trials.map((record) => record.metrics.elapsedMs)),
        totalRetries: trials.reduce(
          (total, record) => total + record.metrics.retries,
          0,
        ),
        totalProviderErrors: trials.reduce(
          (total, record) => total + record.metrics.providerErrors,
          0,
        ),
      };
    });

  return {
    trialCount: records.length,
    devTaskCount: devTaskIds.size,
    evalTaskCount: evalTaskIds.size,
    tokenBudget: records[0]?.metrics.tokenBudget ?? 0,
    conditions,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function number(value: number): string {
  return value.toFixed(1);
}

export function workflowValueSummaryMarkdown(
  summary: WorkflowValueSummary,
): string {
  const rows = summary.conditions.map((condition) =>
    [
      condition.condition,
      condition.trials,
      condition.evalTrials,
      condition.evalSuccessesWithinBudget,
      percent(condition.evalSuccessWithinBudgetRate),
      percent(condition.pairedEvalDifferenceFromTaskOnly),
      percent(condition.validationPassRate),
      percent(condition.parseFailureRate),
      percent(condition.overBudgetRate),
      number(condition.meanWireBytes),
      number(condition.meanHydrationBytes),
      number(condition.meanInputTokens),
      number(condition.meanCachedInputTokens),
      condition.meanReasoningTokens === null
        ? "n/a"
        : number(condition.meanReasoningTokens),
      number(condition.meanOutputTokens),
      number(condition.meanTotalModelTokens),
      condition.meanTokensToFirstPassingSolution === null
        ? "n/a"
        : number(condition.meanTokensToFirstPassingSolution),
      number(condition.meanFailedEditTestCycles),
      number(condition.meanRegressions),
      number(condition.meanReworkCycles),
      number(condition.meanLatencyMs),
      condition.totalRetries,
      condition.totalProviderErrors,
    ].join(" | "),
  );

  return [
    "# Workflow value summary",
    "",
    "> Deterministic scaffold validation only. The bundled tasks are clearly labelled synthetic seed fixtures, not an evaluation dataset. Scripted outcomes are a construction and are not evidence that workflow references improve model performance. The dataset-acquisition gate must open before any model pilot (ADR 0021).",
    "",
    `Primary endpoint: executable-validator success within the fixed ${summary.tokenBudget}-token input+output budget, evaluated on the eval split only.`,
    "",
    "Secondary workflow telemetry includes tokens to first passing solution, failed edit/test cycles, regressions, rework cycles, and latency. The deterministic seed executor is one-shot, so regressions and rework are zero there; injected fake-model tests exercise multi-attempt rework.",
    "",
    `Trials: ${summary.trialCount}; tasks: ${summary.devTaskCount} dev, ${summary.evalTaskCount} eval.`,
    "",
    "Condition | Trials | Eval trials | Eval successes | Eval success rate | Paired Δ vs task-only | Validator pass | Parse failure | Over budget | Mean wire B | Mean hydration B | Mean input tok | Mean cached tok | Mean reasoning tok | Mean output tok | Mean total tok | Tok to first pass | Failed cycles | Regressions | Rework | Mean latency ms | Retries | Provider errors",
    "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}
