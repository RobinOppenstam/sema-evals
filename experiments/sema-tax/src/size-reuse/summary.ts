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
  meanTotalModelTokens: number;
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
        meanTotalModelTokens: mean(modelTokens),
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

export function sizeReuseSummaryMarkdown(summary: SizeReuseSummary): string {
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
      number(condition.meanTotalModelTokens),
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

  return [
    "# Sema tax curve — size/reuse arm summary",
    "",
    "> Harness validation only (ADR 0013). Deterministic-mode outcomes are scripted and are not empirical evidence about language models. Token prices are illustrative constants; the deterministic token model attributes each definition ingestion once per wire delivery (prose: every message; resolver: once), abstracting away provider conversation-history re-billing and prompt caching (observational per ADR 0011). Pattern count is fixed at p8, cache is cold.",
    "",
    `Trials: ${summary.trialCount} across ${summary.scenarioCount} scenarios.`,
    "",
    "Condition | Trials | Size | R | Delivery | Mean score | Cum wire B | Cum hydration B | Total semantic B | Total tok | Score / 1k tok | Score / 1k B",
    "--- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
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
