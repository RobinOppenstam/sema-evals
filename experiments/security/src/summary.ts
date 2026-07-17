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
  /** Aggregate FP allowance: configured per-source budget × evaluated trials. */
  aggregateFpBudget: number;
  aggregateWithinFpBudget: boolean;
  /**
   * Primary endpoint: micro recall over vulnerable variants, reported only
   * when total FP across vulnerable and patched variants is within the
   * condition's aggregate FP allowance.
   */
  recallAtFpBudget: number | null;
  meanWireBytes: number;
  meanHydrationBytes: number;
}

export interface SecuritySummary {
  trialCount: number;
  caseCount: number;
  vulnerableScenarioCount: number;
  cleanNegativeScenarioCount: number;
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

  const caseIds = new Set(records.map((record) => record.caseId));
  const vulnerableScenarioIds = new Set(
    records
      .filter((record) => record.sourceVariant === "vulnerable")
      .map((record) => record.scenarioId),
  );
  const cleanNegativeScenarioIds = new Set(
    records
      .filter((record) => record.sourceVariant === "patched")
      .map((record) => record.scenarioId),
  );
  const trainIds = new Set(
    records
      .filter((record) => record.metrics.split === "train")
      .map((record) => record.caseId),
  );
  const heldoutIds = new Set(
    records
      .filter((record) => record.metrics.split === "heldout")
      .map((record) => record.caseId),
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
      const aggregateFpBudget = fpBudget * trials.length;
      const aggregateWithinFpBudget = totalFalsePositives <= aggregateFpBudget;
      const vulnerableTrials = trials.filter(
        (trial) => trial.sourceVariant === "vulnerable",
      );
      const vulnerableTruePositives = vulnerableTrials.reduce(
        (sum, trial) => sum + trial.metrics.truePositives,
        0,
      );
      const vulnerableFalseNegatives = vulnerableTrials.reduce(
        (sum, trial) => sum + trial.metrics.falseNegatives,
        0,
      );
      const recallDenominator =
        vulnerableTruePositives + vulnerableFalseNegatives;
      const microRecall =
        recallDenominator === 0
          ? 0
          : vulnerableTruePositives / recallDenominator;
      const recallAtFpBudget = aggregateWithinFpBudget ? microRecall : null;

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
        aggregateFpBudget,
        aggregateWithinFpBudget,
        recallAtFpBudget,
        meanWireBytes: mean(trials.map((trial) => trial.metrics.wireBytes)),
        meanHydrationBytes: mean(
          trials.map((trial) => trial.metrics.hydrationBytes),
        ),
      };
    });

  return {
    trialCount: records.length,
    caseCount: caseIds.size,
    vulnerableScenarioCount: vulnerableScenarioIds.size,
    cleanNegativeScenarioCount: cleanNegativeScenarioIds.size,
    trainCaseCount: trainIds.size,
    heldoutCaseCount: heldoutIds.size,
    fpBudget,
    conditions,
  };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
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
      `${condition.totalFalsePositives}/${condition.aggregateFpBudget}`,
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
    `Trials: ${summary.trialCount} across ${summary.caseCount} mutation pairs (${summary.vulnerableScenarioCount} vulnerable variants, ${summary.cleanNegativeScenarioCount} patched clean negatives; ${summary.trainCaseCount} train, ${summary.heldoutCaseCount} heldout). FP allowance: ${summary.fpBudget} per evaluated source.`,
    "",
    "Primary endpoint: micro vulnerability recall over vulnerable variants, reported only when total false-positive findings across vulnerable and patched variants stay within the aggregate allowance.",
    "",
    "Condition | Trials | Mean recall | Recall@FP budget | Per-trial within budget | FP/allowance | TP | FP | FN | Parse fail | Enforced refuse | Mean wire B | Mean hydration B",
    "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}
