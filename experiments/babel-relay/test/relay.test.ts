import { describe, expect, it } from "vitest";

import {
  FixtureReferenceProvider,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  EXPERIMENT_CONDITIONS,
  PROTOCOL_VERSION,
  planPairedMatrix,
  type RelayScenario,
  type TrialProvenance,
} from "@sema-evals/core";
import { summarizeTrials } from "@sema-evals/reporters";

import { runRelayTrial, type RelaySemanticRuntime } from "../src/relay.js";

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
    expect(byCondition["addressed-voluntary"]?.metrics.silentDivergence).toBe(
      false,
    );
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
    expect(
      summary.conditions.find(
        (entry) => entry.condition === "addressed-voluntary",
      )?.silentDivergenceRate,
    ).toBe(0);
  });

  it("uses an official runtime verdict instead of recomputing handshake policy", async () => {
    const entry = scenario(true);
    const [cell] = planPairedMatrix({
      experimentId: "babel-relay-runtime-test",
      protocolVersion: PROTOCOL_VERSION,
      scenarios: [entry],
      scenarioId: (value) => value.id,
      conditions: ["addressed-enforced"] as const,
      seeds: [0],
      orderSeed: 1,
    });
    if (!cell) {
      throw new Error("Expected one runtime test cell.");
    }
    const digest = "d".repeat(64);
    const referenceProvider: SemanticReferenceProvider = {
      backend: "constant-reference-test",
      async metadata() {
        return {
          backend: this.backend,
          semaVersion: "test",
          canonicalizationVersion: "test",
          officialSema: false,
        };
      },
      async reference(handle) {
        return {
          handle,
          display: `${handle}#dddd`,
          full: `fixture:${handle}#sha256:${digest}`,
          digest,
          backend: this.backend,
          officialSema: false,
        };
      },
    };
    const semanticRuntime: RelaySemanticRuntime = {
      backend: "official-workspace-test",
      canonicalVocabularyRoot: "e".repeat(64),
      async hydrate(_scenarioId, _handle, drifted) {
        return {
          definition: drifted
            ? entry.contract.mutatedDefinition
            : entry.contract.canonicalDefinition,
          observedReference: `sema:BoundaryRule#mh:SHA-256:${(drifted
            ? "f"
            : "d"
          ).repeat(64)}`,
          workspaceRoot: (drifted ? "f" : "e").repeat(64),
          resolver: this.backend,
        };
      },
      async handshake(_scenarioId, _handle, _expectedDigest, drifted) {
        return drifted
          ? {
              verdict: "HALT",
              observedReference: `sema:BoundaryRule#mh:SHA-256:${"f".repeat(64)}`,
              workspaceRoot: "f".repeat(64),
              reason: "SEMANTIC DRIFT DETECTED",
              details: { verdict: "HALT", canonical_hash: "ffff" },
            }
          : {
              verdict: "PROCEED",
              observedReference: `sema:BoundaryRule#mh:SHA-256:${"d".repeat(64)}`,
              workspaceRoot: "e".repeat(64),
              details: { verdict: "PROCEED" },
            };
      },
      async cleanup() {},
    };

    const record = await runRelayTrial(cell, {
      experimentId: "babel-relay-runtime-test",
      referenceProvider,
      semanticRuntime,
      provenance,
    });
    const verification = record.events.find(
      (event) =>
        event.type === "verification" && event.details.verdict === "HALT",
    );

    expect(record.actualAction).toBe("halt");
    expect(record.metrics.driftDetected).toBe(true);
    expect(verification?.details).toMatchObject({
      verifier: "official-workspace-test",
      verdict: "HALT",
      reason: "SEMANTIC DRIFT DETECTED",
      officialHandshake: { verdict: "HALT", canonical_hash: "ffff" },
    });
  });
});
