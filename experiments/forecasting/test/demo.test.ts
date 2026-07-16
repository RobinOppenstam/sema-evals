import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  planPairedMatrix,
  type MatrixCell,
  type TrialProvenance,
} from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import { runForecastingTrial } from "../src/demo.js";
import { loadFixtureFile } from "../src/fixtures.js";
import {
  SEMANTIC_MISMATCH_REASON,
  forecastingTrialRecordSchema,
  type ForecastingCondition,
  type ForecastingScenario,
} from "../src/schemas.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/scenarios.yaml",
);

const provenance: TrialProvenance = {
  artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
  protocolVersion: PROTOCOL_VERSION,
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

async function scenarioById(id: string): Promise<ForecastingScenario> {
  const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
  const scenario = fixtureSet.scenarios.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Expected scenario ${id}.`);
  }
  return scenario;
}

function cellFor(
  scenario: ForecastingScenario,
  condition: ForecastingCondition,
): MatrixCell<ForecastingScenario, ForecastingCondition> {
  const [cell] = planPairedMatrix({
    experimentId: "forecasting",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: [scenario],
    scenarioId: (value) => value.id,
    conditions: [condition],
    seeds: [0],
    orderSeed: 1,
  });
  if (!cell) {
    throw new Error("Expected one matrix cell.");
  }
  return cell;
}

async function run(id: string, condition: ForecastingCondition) {
  const scenario = await scenarioById(id);
  return runForecastingTrial(cellFor(scenario, condition), {
    experimentId: "forecasting",
    referenceProvider: new FixtureReferenceProvider(),
    vocabularyRoot: "",
    provenance,
  });
}

describe("baseline: corrupted aggregation under drift", () => {
  it("includes the drifted forecast with no surfaced mismatch", async () => {
    const record = await run("synthetic-prob-format-drift", "baseline");
    expect(record.metrics.driftInjected).toBe(true);
    expect(record.metrics.driftDetected).toBe(false);
    expect(record.metrics.driftedForecastIncluded).toBe(true);
    expect(record.metrics.corruptedAggregation).toBe(true);
    expect(record.metrics.aggregateProbability).toBeCloseTo(12.876, 10);
    expect(record.metrics.forecastsExcluded).toBe(0);
  });

  it("aggregates a no-drift control without corruption", async () => {
    const record = await run("synthetic-prob-format-clean", "baseline");
    expect(record.metrics.driftInjected).toBe(false);
    expect(record.metrics.corruptedAggregation).toBe(false);
    expect(record.metrics.aggregateProbability).toBeCloseTo(0.6, 10);
  });
});

describe("addressed-voluntary: detection without exclusion", () => {
  it("detects the drift and surfaces it but still aggregates all", async () => {
    const record = await run(
      "synthetic-prob-format-drift",
      "addressed-voluntary",
    );
    expect(record.metrics.driftDetected).toBe(true);
    expect(record.metrics.corruptedAggregation).toBe(false);
    expect(record.metrics.forecastsExcluded).toBe(0);
    expect(record.metrics.driftedForecastIncluded).toBe(true);
    expect(record.metrics.aggregateProbability).toBeCloseTo(0.6, 10);
    const verification = record.events.find(
      (event) => event.type === "verification",
    );
    expect(verification?.details["verdict"]).toBe("SURFACE_AND_AGGREGATE_ALL");
  });
});

describe("addressed-enforced: enforced exclusion", () => {
  it("excludes the drifted forecast with a typed reason", async () => {
    const record = await run(
      "synthetic-prob-format-drift",
      "addressed-enforced",
    );
    expect(record.metrics.driftDetected).toBe(true);
    expect(record.metrics.correctExclusion).toBe(true);
    expect(record.metrics.falseExclusion).toBe(false);
    expect(record.metrics.corruptedAggregation).toBe(false);
    expect(record.excludedAgentIds).toEqual(["forecaster-4"]);
    expect(record.metrics.exclusionReasons).toEqual([SEMANTIC_MISMATCH_REASON]);
    expect(record.metrics.aggregateProbability).toBeCloseTo(0.595, 10);
  });

  it("never false-excludes a no-drift control", async () => {
    const record = await run(
      "synthetic-resolution-announced-clean",
      "addressed-enforced",
    );
    expect(record.metrics.driftDetected).toBe(false);
    expect(record.metrics.falseExclusion).toBe(false);
    expect(record.metrics.forecastsExcluded).toBe(0);
    expect(record.metrics.forecastsIncluded).toBe(5);
  });
});

describe("voluntary vs enforced are distinguishable on the same drift", () => {
  it("both detect, but only enforced excludes", async () => {
    const voluntary = await run(
      "synthetic-resolution-announced-drift",
      "addressed-voluntary",
    );
    const enforced = await run(
      "synthetic-resolution-announced-drift",
      "addressed-enforced",
    );
    expect(voluntary.metrics.driftDetected).toBe(true);
    expect(enforced.metrics.driftDetected).toBe(true);
    expect(voluntary.metrics.forecastsExcluded).toBe(0);
    expect(enforced.metrics.forecastsExcluded).toBe(1);
    expect(enforced.excludedAgentIds).toEqual(["forecaster-2"]);
  });
});

describe("Brier baselines", () => {
  it("records market-prior and independent-average Brier on every trial", async () => {
    const record = await run("synthetic-prob-format-drift", "baseline");
    expect(record.metrics.brierMarketPrior).toBeCloseTo((0.48 - 1) ** 2, 10);
    expect(record.metrics.brierIndependentAverage).toBeGreaterThanOrEqual(0);
    expect(record.metrics.brierAggregate).not.toBeNull();
    // Garbage aggregate under baseline → huge Brier.
    expect(record.metrics.brierAggregate!).toBeGreaterThan(100);
  });
});

describe("record shape", () => {
  it("produces schema-valid records with null usage/transcript", async () => {
    const record = await run(
      "synthetic-evidence-cutoff-drift",
      "addressed-enforced",
    );
    expect(forecastingTrialRecordSchema.safeParse(record).success).toBe(true);
    expect(record.usage).toBeNull();
    expect(record.transcript).toBeNull();
    expect(record.question.evidencePack).toBeNull();
    expect(record.round1Forecasts).toHaveLength(5);
    expect(record.round2Forecasts).toHaveLength(5);
  });
});
