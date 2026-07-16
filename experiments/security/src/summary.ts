import { buildConditions } from "./conditions.js";
import type { SecurityCondition, SecurityTrialRecord } from "./schemas.js";

export interface SecurityConditionSummary {
  condition: SecurityCondition;
  trials: number;
  parseFailures: number;
  enforcementRefusals: number;
  totalTruePositives: number;
  totalFalsePositives: number;
  totalFalseNegatives: number;
  /** Mean per-trial recall. */
  meanRecall: number;
  /** Fraction of trials within the configured FP budget. */
  withinFpBudgetRate: number;
  /**
   * Primary endpoint (case-set aggregate): TP / (TP + FN) across trials in this
   * condition, reported only when total FP <= fpBudget * trialCount is not the
   * gating rule — instead we report recallAtBudget as mean recall among trials
   * that are withinFpBudget, or 0 when none qualify.
   */
  recallAtFpBudget: number;
  meanWireBytes: number;
  meanHydrationBytes: number;
}

export interface SecuritySummary {
  trialCount: number;
  scenarioCount: number;
  trainCaseCount: number;
  heldoutCaseCount: number;
  fpBudget: number;
  conditions: SecurityConditionSummary[];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeSecurity(
  records: readonly SecurityTrialRecord[],
  fpBudget: number,
): SecuritySummary {
  const byCondition = new Map<SecurityCondition, SecurityTrialRecord[]>();
  for (const record of records) {
    const current = byCondition.get(record.condition) ?? [];
    current.push(record);
    byCondition.set(record.condition, current);
  }

  const scenarioIds = new Set(records.map((record) => record.scenarioId));
  const trainIds = new Set(
    records
      .filter((record) => record.metrics.split === "train")
      .map((record) => record.scenarioId),
  );
  const heldoutIds = new Set(
    records
      .filter((record) => record.metrics.split === "heldout")
      .map((record) => record.scenarioId),
  );

  const conditions = buildConditions()
    .filter((condition) => byCondition.has(condition))
    .map((condition): SecurityConditionSummary => {
      const trials = byCondition.get(condition) ?? [];
      const totalTruePositives = trials.reduce(
        (sum, trial) => sum + trial.metrics.truePositives,
        0,
      );
      const totalFalsePositives = trials.reduce(
        (sum, trial) => sum + trial.metrics.falsePositives,
        0,
      );
      const totalFalseNegatives = trials.reduce(
        (sum, trial) => sum + trial.metrics.falseNegatives,
        0,
      );
      const withinBudget = trials.filter(
        (trial) => trial.metrics.withinFpBudget,
      );
      const recallAtFpBudget =
        withinBudget.length === 0
          ? 0
          : mean(withinBudget.map((trial) => trial.metrics.recall));

      return {
        condition,
        trials: trials.length,
        parseFailures: trials.filter((trial) => trial.metrics.parseFailure)
          .length,
        enforcementRefusals: trials.filter(
          (trial) => trial.metrics.enforcementRefused,
        ).length,
        totalTruePositives,
        totalFalsePositives,
        totalFalseNegatives,
        meanRecall: mean(trials.map((trial) => trial.metrics.recall)),
        withinFpBudgetRate:
          trials.length === 0 ? 0 : withinBudget.length / trials.length,
        recallAtFpBudget,
        meanWireBytes: mean(trials.map((trial) => trial.metrics.wireBytes)),
        meanHydrationBytes: mean(
          trials.map((trial) => trial.metrics.hydrationBytes),
        ),
      };
    });

  return {
    trialCount: records.length,
    scenarioCount: scenarioIds.size,
    trainCaseCount: trainIds.size,
    heldoutCaseCount: heldoutIds.size,
    fpBudget,
    conditions,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function number(value: number): string {
  return value.toFixed(1);
}

export function securitySummaryMarkdown(summary: SecuritySummary): string {
  const rows = summary.conditions.map((condition) =>
    [
      condition.condition,
      condition.trials,
      percent(condition.meanRecall),
      percent(condition.recallAtFpBudget),
      percent(condition.withinFpBudgetRate),
      condition.totalTruePositives,
      condition.totalFalsePositives,
      condition.totalFalseNegatives,
      condition.parseFailures,
      condition.enforcementRefusals,
      number(condition.meanWireBytes),
      number(condition.meanHydrationBytes),
    ].join(" | "),
  );

  return [
    "# Security domain trials summary",
    "",
    "> Harness validation only. These deterministic, scripted-auditor outcomes are a construction, not empirical evidence about language models (see ADR 0014).",
    "",
    `Trials: ${summary.trialCount} across ${summary.scenarioCount} cases (${summary.trainCaseCount} train, ${summary.heldoutCaseCount} heldout). FP budget: ${summary.fpBudget} per case.`,
    "",
    "Primary endpoint: vulnerability recall at a fixed false-positive budget.",
    "",
    "Condition | Trials | Mean recall | Recall@FP budget | Within budget | TP | FP | FN | Parse fail | Enforced refuse | Mean wire B | Mean hydration B",
    "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}
