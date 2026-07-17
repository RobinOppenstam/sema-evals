import { SEMA_DISCOVERY_CONDITIONS } from "./schemas.js";
import type {
  SemaDiscoveryCondition,
  SemaDiscoveryTrialRecord,
} from "./schemas.js";

export interface DiscoveryConditionSummary {
  condition: SemaDiscoveryCondition;
  trials: number;
  endToEndSuccessRate: number;
  meanSearches: number;
  meanCorrectSelections: number;
  dependencyCompleteRate: number;
  meanExecutionsPassed: number;
  meanReuseHits: number;
  meanSearchesAvoided: number;
  meanResolutionAvoided: number;
  meanWireBytes: number;
  meanHydrationBytes: number;
}

export interface SemaDiscoverySummary {
  trialCount: number;
  scenarioCount: number;
  conditions: DiscoveryConditionSummary[];
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

export function summarizeSemaDiscovery(
  records: readonly SemaDiscoveryTrialRecord[],
): SemaDiscoverySummary {
  const byCondition = new Map<
    SemaDiscoveryCondition,
    SemaDiscoveryTrialRecord[]
  >();
  for (const record of records) {
    const current = byCondition.get(record.condition) ?? [];
    current.push(record);
    byCondition.set(record.condition, current);
  }
  return {
    trialCount: records.length,
    scenarioCount: new Set(records.map((record) => record.scenarioId)).size,
    conditions: SEMA_DISCOVERY_CONDITIONS.filter((condition) =>
      byCondition.has(condition),
    ).map((condition) => {
      const trials = byCondition.get(condition) ?? [];
      return {
        condition,
        trials: trials.length,
        endToEndSuccessRate: mean(
          trials.map((trial) =>
            trial.metrics.endToEndDiscoverySuccess ? 1 : 0,
          ),
        ),
        meanSearches: mean(
          trials.map((trial) => trial.metrics.searchesPerformed),
        ),
        meanCorrectSelections: mean(
          trials.map((trial) => trial.metrics.correctSelections),
        ),
        dependencyCompleteRate: mean(
          trials.map((trial) => (trial.metrics.dependencyComplete ? 1 : 0)),
        ),
        meanExecutionsPassed: mean(
          trials.map((trial) => trial.metrics.executionsPassed),
        ),
        meanReuseHits: mean(trials.map((trial) => trial.metrics.reuseHits)),
        meanSearchesAvoided: mean(
          trials.map((trial) => trial.metrics.searchesAvoided),
        ),
        meanResolutionAvoided: mean(
          trials.map((trial) => trial.metrics.dependencyResolutionsAvoided),
        ),
        meanWireBytes: mean(trials.map((trial) => trial.metrics.wireBytes)),
        meanHydrationBytes: mean(
          trials.map((trial) => trial.metrics.hydrationBytes),
        ),
      };
    }),
  };
}

export function semaDiscoverySummaryMarkdown(
  summary: SemaDiscoverySummary,
): string {
  return [
    "# Sema discovery and reuse summary",
    "",
    "> Deterministic mechanism/scaffold validation only. Scripted search and execution outcomes are constructed and are not evidence that models discover useful patterns or that a library improves workflow performance.",
    "",
    `Trials: ${summary.trialCount} across ${summary.scenarioCount} scenarios.`,
    "",
    "Primary descriptive endpoint: correct discovery, complete dependency resolution, and validator-passing execution for both session tasks.",
    "",
    "Condition | Trials | End-to-end discovery | Mean searches | Mean correct selections | Dependency complete | Mean executions passed | Mean reuse hits | Searches avoided | Resolutions avoided | Mean wire B | Mean hydration B",
    "--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:",
    ...summary.conditions.map((condition) =>
      [
        condition.condition,
        condition.trials,
        `${(condition.endToEndSuccessRate * 100).toFixed(1)}%`,
        condition.meanSearches.toFixed(1),
        condition.meanCorrectSelections.toFixed(1),
        `${(condition.dependencyCompleteRate * 100).toFixed(1)}%`,
        condition.meanExecutionsPassed.toFixed(1),
        condition.meanReuseHits.toFixed(1),
        condition.meanSearchesAvoided.toFixed(1),
        condition.meanResolutionAvoided.toFixed(1),
        condition.meanWireBytes.toFixed(1),
        condition.meanHydrationBytes.toFixed(1),
      ].join(" | "),
    ),
    "",
  ].join("\n");
}
