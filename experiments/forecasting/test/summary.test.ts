import { describe, expect, it } from "vitest";

import {
  forecastingSummaryMarkdown,
  recomputeTrialBriers,
  summarizeForecasting,
} from "../src/summary.js";
import {
  forecastingTrialRecordSchema,
  type ForecastingCondition,
  type ForecastingMetrics,
  type ForecastingTrialRecord,
} from "../src/schemas.js";
import { brierScore } from "../src/scoring.js";

const provenance = {
  artifactSchemaVersion: "0.3.0",
  protocolVersion: "0.3.0",
  fixtureDigest: "a".repeat(64),
  implementationCommit: "test",
  dependencyLockDigest: "b".repeat(64),
  promptDigest: "c".repeat(64),
  semaVersion: "not-connected",
  canonicalizationVersion: "fixture-stable-json-v1",
  vocabularyRoot: "",
  semanticBackend: "fixture-sha256-stable-json-v1",
  modelProvider: "deterministic",
  modelName: "forecasting-council-demo-v1",
};

const question = {
  questionText: "Will Q?",
  resolutionCriteria: "Resolves YES if Q.",
  resolutionTimestamp: "2024-07-01T00:00:00.000Z",
  resolvedOutcome: "YES" as const,
  marketPrior: 0.4,
  evidencePack: null,
};

const leakageAudit = {
  model: "synthetic-auditor-v1",
  zeroEvidenceAnswer: "YES" as const,
  confidence: 0.7,
  verdict: "keep" as const,
};

let counter = 0;

function record(
  condition: ForecastingCondition,
  driftInjected: boolean,
  overrides: Partial<ForecastingMetrics>,
): ForecastingTrialRecord {
  counter += 1;
  const aggregateProbability = overrides.aggregateProbability ?? 0.6;
  const marketPrior = overrides.marketPrior ?? 0.4;
  const independentAverage = overrides.independentAverage ?? 0.55;
  const outcome = overrides.outcome ?? "YES";
  const metrics: ForecastingMetrics = {
    driftInjected,
    referencesCarried: condition !== "baseline",
    verificationPerformed: condition !== "baseline",
    referencesChecked: 0,
    referencesMatched: 0,
    referencesMismatched: 0,
    driftDetected: false,
    forecastsSubmitted: 5,
    forecastsIncluded: 5,
    forecastsExcluded: 0,
    driftedForecastIncluded: driftInjected,
    corruptedAggregation: false,
    correctExclusion: false,
    falseExclusion: false,
    aggregateProbability,
    marketPrior,
    independentAverage,
    brierAggregate: brierScore(aggregateProbability, outcome),
    brierMarketPrior: brierScore(marketPrior, outcome),
    brierIndependentAverage: brierScore(independentAverage, outcome),
    outcome,
    exclusionReasons: [],
    wireBytes: 100,
    hydrationBytes: 200,
    totalSemanticBytes: 300,
    elapsedMs: 1,
    ...overrides,
  };
  return forecastingTrialRecordSchema.parse({
    trialId: counter.toString(16).padStart(64, "0"),
    experimentId: "forecasting",
    scenarioId: `${condition}-${driftInjected ? "drift" : "clean"}-${counter}`,
    condition,
    seed: 0,
    executionIndex: counter,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    driftInjected,
    question,
    leakageAudit,
    round1Forecasts: [],
    round2Forecasts: [],
    includedAgentIds: [],
    excludedAgentIds: [],
    events: [],
    metrics,
    provenance,
    usage: null,
    transcript: null,
  });
}

describe("summarizeForecasting math", () => {
  it("computes corrupted-aggregation and false-exclusion rates over the right denominators", () => {
    const records: ForecastingTrialRecord[] = [
      record("addressed-enforced", true, {
        driftDetected: true,
        correctExclusion: true,
        forecastsExcluded: 1,
        driftedForecastIncluded: false,
      }),
      record("addressed-enforced", true, {
        driftDetected: true,
        correctExclusion: true,
        forecastsExcluded: 1,
        driftedForecastIncluded: false,
      }),
      record("addressed-enforced", false, {}),
      record("addressed-enforced", false, {}),
    ];
    const summary = summarizeForecasting(records);
    const enforced = summary.conditions[0];
    expect(enforced?.condition).toBe("addressed-enforced");
    expect(enforced?.trials).toBe(4);
    expect(enforced?.driftTrials).toBe(2);
    expect(enforced?.detectionRate).toBe(1);
    expect(enforced?.corruptedAggregationRate).toBe(0);
    expect(enforced?.falseExclusions).toBe(0);
    expect(enforced?.falseExclusionRate).toBe(0);
    expect(summary.leakageAuditPassed).toBe(true);
  });

  it("counts a baseline corrupted aggregation and reports zero-denominator rates as zero", () => {
    const records = [
      record("baseline", true, {
        corruptedAggregation: true,
        driftedForecastIncluded: true,
        aggregateProbability: 12.876,
        brierAggregate: brierScore(12.876, "YES"),
      }),
    ];
    const summary = summarizeForecasting(records);
    const baseline = summary.conditions[0];
    expect(baseline?.corruptedAggregationRate).toBe(1);
    expect(baseline?.detectionRate).toBe(0);
    expect(baseline?.cleanTrials).toBe(0);
    expect(baseline?.falseExclusionRate).toBe(0);
  });

  it("recomputes Brier values in the summary from raw trial records", () => {
    const records = [
      record("baseline", false, {
        aggregateProbability: 0.7,
        marketPrior: 0.4,
        independentAverage: 0.55,
        outcome: "YES",
      }),
      record("baseline", false, {
        aggregateProbability: 0.3,
        marketPrior: 0.5,
        independentAverage: 0.4,
        outcome: "NO",
      }),
    ];
    for (const trial of records) {
      const recomputed = recomputeTrialBriers(trial);
      expect(recomputed.brierAggregate).toBe(trial.metrics.brierAggregate);
      expect(recomputed.brierMarketPrior).toBe(trial.metrics.brierMarketPrior);
      expect(recomputed.brierIndependentAverage).toBe(
        trial.metrics.brierIndependentAverage,
      );
    }
    const summary = summarizeForecasting(records);
    const baseline = summary.conditions[0];
    const expectedMeanAgg =
      (records[0]!.metrics.brierAggregate! +
        records[1]!.metrics.brierAggregate!) /
      2;
    expect(baseline?.meanBrierAggregate).toBeCloseTo(expectedMeanAgg, 10);
    expect(baseline?.modelFailureCount).toBe(0);
  });

  it("fails the leakage audit gate when a recorded audit is missing keep", () => {
    const bad = record("baseline", false, {});
    const mutated = {
      ...bad,
      leakageAudit: { ...bad.leakageAudit, verdict: "drop" as const },
    };
    const summary = summarizeForecasting([mutated]);
    expect(summary.leakageAuditPassed).toBe(false);
    expect(summary.leakageAuditFailures[0]).toMatch(/verdict is drop/);
  });

  it("renders a markdown table with a harness-validation disclaimer", () => {
    const records = [
      record("baseline", true, { corruptedAggregation: true }),
      record("addressed-enforced", true, {
        driftDetected: true,
        correctExclusion: true,
      }),
    ];
    const markdown = forecastingSummaryMarkdown(summarizeForecasting(records));
    expect(markdown).toContain("# Forecasting council summary");
    expect(markdown).toContain("baseline");
    expect(markdown).toContain("addressed-enforced");
    expect(markdown).toContain("Harness validation only");
  });
});
