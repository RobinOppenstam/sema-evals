import { describe, expect, it } from "vitest";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  EXPERIMENT_CONDITIONS,
  PROTOCOL_VERSION,
  planPairedMatrix,
  type RelayScenario,
  type TrialProvenance,
} from "@sema-evals/core";
import { summarizeTrials } from "@sema-evals/reporters";

import { runRelayTrial } from "../src/relay.js";

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
  modelName: "relay-test",
};

function scenario(withDrift: boolean): RelayScenario {
  const canonicalDefinition = { invariant: "amount >= 100" };
  const mutatedDefinition = withDrift
    ? { invariant: "amount > 100" }
    : canonicalDefinition;
  return {
    id: withDrift ? "drift" : "control",
    title: withDrift ? "Drift" : "Control",
    description: "Apply the exact boundary rule.",
    contract: {
      handle: "BoundaryRule",
      opaqueRef: "rule:boundary-v1",
      canonicalDefinition,
      mutatedDefinition,
    },
    mutation: withDrift
      ? {
          boundary: "plan-to-implementation",
          fieldPath: "invariant",
          before: "amount >= 100",
          after: "amount > 100",
        }
      : null,
    expectedAction: withDrift ? "halt" : "proceed",
  };
}

async function runScenario(entry: RelayScenario) {
  const cells = planPairedMatrix({
    experimentId: "babel-relay-test",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: [entry],
    scenarioId: (value) => value.id,
    conditions: EXPERIMENT_CONDITIONS,
    seeds: [0],
    orderSeed: 1,
  });
  const referenceProvider = new FixtureReferenceProvider();
  return Promise.all(
    cells.map((cell) =>
      runRelayTrial(cell, {
        experimentId: "babel-relay-test",
        referenceProvider,
        provenance,
      }),
    ),
  );
}

describe("Babel Relay scoring", () => {
  it("separates opaque, detected, and enforced drift outcomes", async () => {
    const records = await runScenario(scenario(true));
    const byCondition = Object.fromEntries(
      records.map((record) => [record.condition, record]),
    );

    expect(byCondition.baseline?.metrics.silentDivergence).toBe(true);
    expect(byCondition["equal-prose"]?.metrics.silentDivergence).toBe(true);
    expect(byCondition["opaque-resolver"]?.metrics.driftDetected).toBe(false);
    expect(byCondition["addressed-voluntary"]?.metrics.driftDetected).toBe(
      true,
    );
    expect(byCondition["addressed-voluntary"]?.metrics.halted).toBe(false);
    expect(byCondition["addressed-enforced"]?.metrics.driftDetected).toBe(true);
    expect(byCondition["addressed-enforced"]?.metrics.halted).toBe(true);
    expect(byCondition["addressed-enforced"]?.metrics.taskSuccess).toBe(true);
  });

  it("does not false-halt an aligned control", async () => {
    const records = await runScenario(scenario(false));
    expect(records.every((record) => record.metrics.taskSuccess)).toBe(true);
    expect(records.every((record) => !record.metrics.falseHalt)).toBe(true);
    expect(records.every((record) => !record.metrics.driftDetected)).toBe(true);
  });

  it("aggregates condition rates from raw records", async () => {
    const driftRecords = await runScenario(scenario(true));
    const controlRecords = await runScenario(scenario(false));
    const summary = summarizeTrials([...driftRecords, ...controlRecords]);

    expect(summary.trialCount).toBe(10);
    expect(
      summary.conditions.find(
        (entry) => entry.condition === "addressed-enforced",
      )?.taskSuccessRate,
    ).toBe(1);
    expect(
      summary.conditions.find((entry) => entry.condition === "opaque-resolver")
        ?.silentDivergenceRate,
    ).toBe(1);
  });
});
