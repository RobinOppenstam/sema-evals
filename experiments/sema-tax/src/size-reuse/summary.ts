import {
  buildSizeReuseConditions,
  parseSizeReuseCondition,
} from "./conditions.js";
import {
  SEMA_TAX_REUSE_FACTORS,
  SEMA_TAX_SIZE_TIERS,
  type SemaTaxSizeReuseTrialRecord,
} from "./schemas.js";

export interface SizeReuseConditionSummary {
  condition: string;
  patternCount: number;
  size: string;
  reuse: number;
  delivery: string;
  trials: number;
  meanScore: number;
  taskSuccessRate: number;
  meanCumulativeWireBytes: number;
  meanCumulativeHydrationBytes: number;
  meanTotalSemanticBytes: number;
  meanInputTokens: number;
  meanCachedInputTokensRead: number;
  meanCachedInputTokensWritten: number;
  meanOutputTokens: number;
  meanReasoningTokens: number | null;
  meanTotalModelTokens: number;
  modelMessages: number;
  modelFailureMessages: number;
  modelFailureRate: number;
  totalAttempts: number;
  totalRetries: number;
  totalProviderErrors: number;
  meanCostUsd: number | null;
  /** Primary endpoint 1: graded score per 1000 billable model tokens. */
  scorePerKToken: number;
  /** Primary endpoint 2: graded score per 1000 total semantic bytes (wire +
   * hydration). This is the byte channel where reference reuse amortizes. */
  scorePerKSemanticByte: number;
}

/** One (size, reuse) cell of the crossover surface: prose vs the resolver arms
 * on the two primary denominators. `contentBeatsProse*` marks where the
 * content-addressed arm has crossed prose (lower total, so higher score-per-unit
 * at equal score). */
export interface SizeReuseCrossing {
  size: string;
  reuse: number;
  proseTotalSemanticBytes: number;
  opaqueTotalSemanticBytes: number;
  contentTotalSemanticBytes: number;
  proseTotalModelTokens: number;
  opaqueTotalModelTokens: number;
  contentTotalModelTokens: number;
  contentBeatsProseBytes: boolean;
  contentBeatsProseTokens: boolean;
}

export interface SizeReuseSummary {
  trialCount: number;
  scenarioCount: number;
  conditions: SizeReuseConditionSummary[];
  crossings: SizeReuseCrossing[];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratePerK(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 1000;
}

export function summarizeSizeReuse(
  records: readonly SemaTaxSizeReuseTrialRecord[],
): SizeReuseSummary {
  const byCondition = new Map<string, SemaTaxSizeReuseTrialRecord[]>();
  for (const record of records) {
    const current = byCondition.get(record.condition) ?? [];
    current.push(record);
    byCondition.set(record.condition, current);
  }

  const conditions = buildSizeReuseConditions()
    .filter((condition) => byCondition.has(condition))
    .map((condition) => {
      const trials = byCondition.get(condition) ?? [];
      const parts = parseSizeReuseCondition(condition);
      const scores = trials.map((trial) => trial.metrics.score);
      const semanticBytes = trials.map(
        (trial) => trial.metrics.totalSemanticBytes,
      );
      const modelTokens = trials.map((trial) => trial.metrics.totalModelTokens);
      const costs = trials
        .map((trial) => trial.metrics.costUsd)
        .filter((value): value is number => value !== null);
      const taskSuccesses = trials.filter(
        (trial) => trial.metrics.taskSuccess,
      ).length;
      const modelMessages = trials.reduce(
        (total, trial) =>
          total +
          trial.metrics.messages.filter((message) => message.usage !== null)
            .length,
        0,
      );
      const modelFailureMessages = trials.reduce(
        (total, trial) => total + trial.metrics.modelFailureMessages,
        0,
      );
      const reasoning = trials
        .map((trial) => trial.metrics.reasoningTokens)
        .filter((value): value is number => value !== null);
      const summedScore = scores.reduce((sum, value) => sum + value, 0);
      return {
        condition,
        patternCount: parts.patternCount,
        size: parts.size,
        reuse: parts.reuse,
        delivery: parts.delivery,
        trials: trials.length,
        meanScore: mean(scores),
        taskSuccessRate:
          trials.length === 0 ? 0 : taskSuccesses / trials.length,
        meanCumulativeWireBytes: mean(
          trials.map((trial) => trial.metrics.cumulativeWireBytes),
        ),
        meanCumulativeHydrationBytes: mean(
          trials.map((trial) => trial.metrics.cumulativeHydrationBytes),
        ),
        meanTotalSemanticBytes: mean(semanticBytes),
        meanInputTokens: mean(
          trials.map((trial) => trial.metrics.totalInputTokens),
        ),
        meanCachedInputTokensRead: mean(
          trials.map((trial) => trial.metrics.totalCachedInputTokensRead),
        ),
        meanCachedInputTokensWritten: mean(
          trials.map((trial) => trial.metrics.totalCachedInputTokensWritten),
        ),
        meanOutputTokens: mean(
          trials.map((trial) => trial.metrics.totalOutputTokens),
        ),
        meanReasoningTokens: reasoning.length === 0 ? null : mean(reasoning),
        meanTotalModelTokens: mean(modelTokens),
        modelMessages,
        modelFailureMessages,
        modelFailureRate:
          modelMessages === 0 ? 0 : modelFailureMessages / modelMessages,
        totalAttempts: trials.reduce(
          (total, trial) => total + trial.metrics.totalAttempts,
          0,
        ),
        totalRetries: trials.reduce(
          (total, trial) => total + trial.metrics.totalRetries,
          0,
        ),
        totalProviderErrors: trials.reduce(
          (total, trial) => total + trial.metrics.totalProviderErrors,
          0,
        ),
        meanCostUsd: costs.length === 0 ? null : mean(costs),
        scorePerKToken: ratePerK(
          summedScore,
          modelTokens.reduce((sum, value) => sum + value, 0),
        ),
        scorePerKSemanticByte: ratePerK(
          summedScore,
          semanticBytes.reduce((sum, value) => sum + value, 0),
        ),
      };
    });

  const byId = new Map(conditions.map((row) => [row.condition, row]));
  const crossings: SizeReuseCrossing[] = [];
  for (const size of SEMA_TAX_SIZE_TIERS) {
    for (const reuse of SEMA_TAX_REUSE_FACTORS) {
      const prose = byId.get(`p8-${size}-r${reuse}-prose-cold`);
      const opaque = byId.get(`p8-${size}-r${reuse}-opaque-cold`);
      const content = byId.get(`p8-${size}-r${reuse}-content-cold`);
      if (!prose || !opaque || !content) {
        continue;
      }
      crossings.push({
        size,
        reuse,
        proseTotalSemanticBytes: prose.meanTotalSemanticBytes,
        opaqueTotalSemanticBytes: opaque.meanTotalSemanticBytes,
        contentTotalSemanticBytes: content.meanTotalSemanticBytes,
        proseTotalModelTokens: prose.meanTotalModelTokens,
        opaqueTotalModelTokens: opaque.meanTotalModelTokens,
        contentTotalModelTokens: content.meanTotalModelTokens,
        contentBeatsProseBytes:
          content.meanTotalSemanticBytes < prose.meanTotalSemanticBytes,
        contentBeatsProseTokens:
          content.meanTotalModelTokens < prose.meanTotalModelTokens,
      });
    }
  }

  return {
    trialCount: records.length,
    scenarioCount: new Set(records.map((record) => record.scenarioId)).size,
    conditions,
    crossings,
  };
}

function number(value: number, digits = 1): string {
  return value.toFixed(digits);
}

export type SizeReuseSummaryMode =
  "deterministic-harness" | "model-pilot" | "confirmatory";

export function sizeReuseSummaryMarkdown(
  summary: SizeReuseSummary,
  mode: SizeReuseSummaryMode = "deterministic-harness",
): string {
  const isModelRun = mode !== "deterministic-harness";
  const rows = summary.conditions.map((condition) =>
    [
      condition.condition,
      condition.trials,
      condition.size,
      condition.reuse,
      condition.delivery,
      number(condition.meanScore, 3),
      number(condition.meanCumulativeWireBytes),
      number(condition.meanCumulativeHydrationBytes),
      number(condition.meanTotalSemanticBytes),
      ...(isModelRun
        ? [
            number(condition.meanInputTokens),
            number(condition.meanCachedInputTokensRead),
            number(condition.meanCachedInputTokensWritten),
            number(condition.meanOutputTokens),
            condition.meanReasoningTokens === null
              ? "n/a"
              : number(condition.meanReasoningTokens),
            number(condition.meanTotalModelTokens),
            condition.modelFailureMessages,
            `${(condition.modelFailureRate * 100).toFixed(1)}%`,
            condition.totalRetries,
            condition.totalProviderErrors,
          ]
        : [number(condition.meanTotalModelTokens)]),
      number(condition.scorePerKToken, 4),
      number(condition.scorePerKSemanticByte, 4),
    ].join(" | "),
  );

  const crossRows = summary.crossings.map((crossing) =>
    [
      crossing.size,
      crossing.reuse,
      number(crossing.proseTotalSemanticBytes),
      number(crossing.contentTotalSemanticBytes),
      crossing.contentBeatsProseBytes ? "yes" : "no",
      number(crossing.proseTotalModelTokens),
      number(crossing.contentTotalModelTokens),
      crossing.contentBeatsProseTokens ? "yes" : "no",
    ].join(" | "),
  );

  const caveat = isModelRun
    ? "> Exploratory model-run results (ADR 0013), not confirmatory evidence. Wire and resolver hydration are harness-measured byte channels. Input, cached-input, reasoning, output, retry, error, stop, and cost telemetry are provider-reported and preserved per message; cached input may overlap provider-reported input totals (ADR 0011)."
    : "> Harness validation only (ADR 0013). Deterministic-mode outcomes are scripted and are not empirical evidence about language models. Token prices are illustrative constants; the deterministic token model attributes each definition ingestion once per wire delivery (prose: every message; resolver: once), abstracting away provider conversation-history re-billing and prompt caching (observational per ADR 0011). Pattern count is fixed at p8, cache is cold.";
  const tableHeader = isModelRun
    ? "Condition | Trials | Size | R | Delivery | Mean score | Cum wire B | Cum hydration B | Total semantic B | Input tok | Cached read tok | Cached write tok | Output tok | Reasoning tok | Total tok | Failed calls | Failure rate | Retries | Provider errors | Score / 1k tok | Score / 1k B"
    : "Condition | Trials | Size | R | Delivery | Mean score | Cum wire B | Cum hydration B | Total semantic B | Total tok | Score / 1k tok | Score / 1k B";
  const tableAlignment = isModelRun
    ? "--- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:"
    : "--- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:";

  return [
    "# Sema tax curve — size/reuse arm summary",
    "",
    caveat,
    "",
    `Trials: ${summary.trialCount} across ${summary.scenarioCount} scenarios.`,
    "",
    tableHeader,
    tableAlignment,
    ...rows,
    "",
    "## Crossover surface (prose vs content-addressed, per size × R)",
    "",
    "Size | R | Prose semantic B | Content semantic B | Content wins B | Prose tok | Content tok | Content wins tok",
    "--- | ---: | ---: | ---: | :---: | ---: | ---: | :---:",
    ...crossRows,
    "",
  ].join("\n");
}
