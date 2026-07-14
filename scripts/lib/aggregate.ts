import {
  EXPERIMENT_CONDITIONS,
  type ExperimentCondition,
  type TrialRecord,
} from "../../packages/core/src/schemas.js";

/**
 * Single-outcome classification of a trial, used for the per-scenario grid. The
 * categories are mutually exclusive and ordered by reporting priority: a silent
 * divergence (the primary harm) outranks any halt, which outranks a plain task
 * success or failure.
 */
export type TrialOutcome =
  "silent-divergence" | "correct-halt" | "false-halt" | "success" | "failure";

export function classifyOutcome(record: TrialRecord): TrialOutcome {
  const m = record.metrics;
  if (m.silentDivergence) {
    return "silent-divergence";
  }
  if (m.correctHalt) {
    return "correct-halt";
  }
  if (m.falseHalt) {
    return "false-halt";
  }
  if (m.taskSuccess) {
    return "success";
  }
  return "failure";
}

export interface ConditionAggregate {
  condition: ExperimentCondition;
  trials: number;
  driftTrials: number;
  detected: number;
  halted: number;
  silentDivergences: number;
  correctHalts: number;
  falseHalts: number;
  taskSuccesses: number;
  detectionRate: number;
  silentDivergenceRate: number;
  taskSuccessRate: number;
}

export interface ScenarioGridCell {
  scenarioId: string;
  condition: ExperimentCondition;
  outcomes: TrialOutcome[];
  /** Trial seeds, aligned index-for-index with {@link outcomes}. */
  seeds: number[];
}

export interface SiteAggregate {
  trialCount: number;
  scenarioCount: number;
  conditions: ConditionAggregate[];
  scenarioIds: string[];
  grid: ScenarioGridCell[];
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function count(
  records: readonly TrialRecord[],
  key: keyof TrialRecord["metrics"],
): number {
  return records.filter((record) => record.metrics[key] === true).length;
}

/**
 * Recompute every reported aggregate directly from trial records. The site never
 * trusts a pre-computed `summary.json`; see {@link compareWithSummary}.
 *
 * `silentDivergenceRate` and `detectionRate` are conditioned on drift trials
 * (their natural denominator); `taskSuccessRate` is over all trials. Rates are
 * reported alongside raw counts because the experiment standard requires counts.
 */
export function aggregateTrials(
  records: readonly TrialRecord[],
): SiteAggregate {
  const byCondition = new Map<ExperimentCondition, TrialRecord[]>();
  for (const record of records) {
    const current = byCondition.get(record.condition) ?? [];
    current.push(record);
    byCondition.set(record.condition, current);
  }

  const scenarioIds = [
    ...new Set(records.map((record) => record.scenarioId)),
  ].sort();

  const conditions: ConditionAggregate[] = EXPERIMENT_CONDITIONS.filter(
    (condition) => byCondition.has(condition),
  ).map((condition) => {
    const trials = byCondition.get(condition) ?? [];
    const driftTrials = trials.filter((trial) => trial.metrics.driftInjected);
    const detected = count(driftTrials, "driftDetected");
    const silentDivergences = count(driftTrials, "silentDivergence");
    const taskSuccesses = count(trials, "taskSuccess");
    return {
      condition,
      trials: trials.length,
      driftTrials: driftTrials.length,
      detected,
      halted: count(trials, "halted"),
      silentDivergences,
      correctHalts: count(trials, "correctHalt"),
      falseHalts: count(trials, "falseHalt"),
      taskSuccesses,
      detectionRate: rate(detected, driftTrials.length),
      silentDivergenceRate: rate(silentDivergences, driftTrials.length),
      taskSuccessRate: rate(taskSuccesses, trials.length),
    };
  });

  const presentConditions = conditions.map((c) => c.condition);
  const grid: ScenarioGridCell[] = [];
  for (const scenarioId of scenarioIds) {
    for (const condition of presentConditions) {
      const cellRecords = records
        .filter(
          (record) =>
            record.scenarioId === scenarioId && record.condition === condition,
        )
        .sort((a, b) => a.seed - b.seed);
      grid.push({
        scenarioId,
        condition,
        outcomes: cellRecords.map(classifyOutcome),
        seeds: cellRecords.map((record) => record.seed),
      });
    }
  }

  return {
    trialCount: records.length,
    scenarioCount: scenarioIds.length,
    conditions,
    scenarioIds,
    grid,
  };
}

/**
 * Shape of the fields the site cross-checks against a bundle's `summary.json`.
 * Kept intentionally loose so a schema drift in the summary reporter surfaces as
 * a warning rather than a hard parse failure.
 */
export interface SummaryConditionLike {
  condition?: string;
  trials?: number;
  driftTrials?: number;
  detected?: number;
  halted?: number;
  silentDivergences?: number;
  taskSuccesses?: number;
  falseHalts?: number;
  silentDivergenceRate?: number;
  taskSuccessRate?: number;
}

export interface SummaryLike {
  trialCount?: number;
  scenarioCount?: number;
  conditions?: SummaryConditionLike[];
}

const RATE_EPSILON = 1e-9;

/**
 * Compare a freshly recomputed aggregate against a bundle's committed
 * `summary.json` and return a list of human-readable mismatch messages. An empty
 * list means the summary is faithful to the trials. Warning (not failing) on
 * mismatch keeps the site buildable while still surfacing drift — a self-check
 * that is on-brand for this repository.
 */
export function compareWithSummary(
  aggregate: SiteAggregate,
  summary: SummaryLike,
): string[] {
  const warnings: string[] = [];

  if (
    summary.trialCount !== undefined &&
    summary.trialCount !== aggregate.trialCount
  ) {
    warnings.push(
      `trialCount: summary=${summary.trialCount} recomputed=${aggregate.trialCount}`,
    );
  }
  if (
    summary.scenarioCount !== undefined &&
    summary.scenarioCount !== aggregate.scenarioCount
  ) {
    warnings.push(
      `scenarioCount: summary=${summary.scenarioCount} recomputed=${aggregate.scenarioCount}`,
    );
  }

  // An absent `conditions` field means the summary does not describe conditions,
  // so there is nothing to cross-check. A present-but-partial array, however, is
  // compared: a condition missing from it is a genuine mismatch.
  if (!Array.isArray(summary.conditions)) {
    return warnings;
  }

  const summaryByCondition = new Map<string, SummaryConditionLike>();
  for (const condition of summary.conditions) {
    if (condition.condition !== undefined) {
      summaryByCondition.set(condition.condition, condition);
    }
  }

  for (const computed of aggregate.conditions) {
    const reported = summaryByCondition.get(computed.condition);
    if (reported === undefined) {
      warnings.push(`${computed.condition}: missing from summary.json`);
      continue;
    }
    const intChecks: [string, number | undefined, number][] = [
      ["trials", reported.trials, computed.trials],
      ["driftTrials", reported.driftTrials, computed.driftTrials],
      ["detected", reported.detected, computed.detected],
      ["halted", reported.halted, computed.halted],
      [
        "silentDivergences",
        reported.silentDivergences,
        computed.silentDivergences,
      ],
      ["taskSuccesses", reported.taskSuccesses, computed.taskSuccesses],
      ["falseHalts", reported.falseHalts, computed.falseHalts],
    ];
    for (const [field, reportedValue, computedValue] of intChecks) {
      if (reportedValue !== undefined && reportedValue !== computedValue) {
        warnings.push(
          `${computed.condition}.${field}: summary=${reportedValue} recomputed=${computedValue}`,
        );
      }
    }
    const rateChecks: [string, number | undefined, number][] = [
      [
        "silentDivergenceRate",
        reported.silentDivergenceRate,
        computed.silentDivergenceRate,
      ],
      ["taskSuccessRate", reported.taskSuccessRate, computed.taskSuccessRate],
    ];
    for (const [field, reportedValue, computedValue] of rateChecks) {
      if (
        reportedValue !== undefined &&
        Math.abs(reportedValue - computedValue) > RATE_EPSILON
      ) {
        warnings.push(
          `${computed.condition}.${field}: summary=${reportedValue} recomputed=${computedValue}`,
        );
      }
    }
  }

  return warnings;
}
