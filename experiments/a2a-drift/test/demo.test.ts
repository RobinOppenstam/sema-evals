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

import { runA2aDriftTrial } from "../src/demo.js";
import { loadFixtureFile } from "../src/fixtures.js";
import { SEMANTIC_MISMATCH_REASON } from "../src/middleware.js";
import {
  a2aDriftTrialRecordSchema,
  type A2aDriftCondition,
  type A2aDriftScenario,
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
  modelName: "a2a-drift-demo-v1",
};

async function scenarioById(id: string): Promise<A2aDriftScenario> {
  const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
  const scenario = fixtureSet.scenarios.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Expected scenario ${id}.`);
  }
  return scenario;
}

function cellFor(
  scenario: A2aDriftScenario,
  condition: A2aDriftCondition,
): MatrixCell<A2aDriftScenario, A2aDriftCondition> {
  const [cell] = planPairedMatrix({
    experimentId: "a2a-drift",
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

async function run(id: string, condition: A2aDriftCondition) {
  const scenario = await scenarioById(id);
  return runA2aDriftTrial(cellFor(scenario, condition), {
    experimentId: "a2a-drift",
    referenceProvider: new FixtureReferenceProvider(),
    vocabularyRoot: "",
    provenance,
  });
}

describe("baseline: silent execution under drift", () => {
  it("completes a drift task using the worker's drifted definition with no surfaced mismatch", async () => {
    const record = await run("settlement-drift", "baseline");
    expect(record.metrics.driftInjected).toBe(true);
    expect(record.metrics.driftDetected).toBe(false);
    expect(record.metrics.silentExecution).toBe(true);
    expect(record.finalTaskState).toBe("completed");
    expect(record.metrics.halted).toBe(false);
    // The safety-correct terminal for a drift task is `failed`; baseline missed it.
    expect(record.metrics.taskSuccess).toBe(false);
    // No verification event is present.
    expect(record.events.some((event) => event.type === "verification")).toBe(
      false,
    );
  });

  it("completes a no-drift control with no detection and task success", async () => {
    const record = await run("settlement-clean", "baseline");
    expect(record.metrics.driftInjected).toBe(false);
    expect(record.metrics.silentExecution).toBe(false);
    expect(record.finalTaskState).toBe("completed");
    expect(record.metrics.taskSuccess).toBe(true);
  });
});

describe("advertised-voluntary: detection without halt", () => {
  it("detects the drift and surfaces it but still completes the task", async () => {
    const record = await run("settlement-drift", "advertised-voluntary");
    expect(record.metrics.driftDetected).toBe(true);
    expect(record.metrics.silentExecution).toBe(false);
    expect(record.metrics.halted).toBe(false);
    expect(record.finalTaskState).toBe("completed");
    // Detected, but the drifted work still shipped: not the safety-correct end.
    expect(record.metrics.taskSuccess).toBe(false);
    expect(record.metrics.referencesMismatched).toBe(1);
    const verification = record.events.find(
      (event) => event.type === "verification",
    );
    expect(verification?.details["verdict"]).toBe("PROCEED");
  });
});

describe("advertised-enforced: enforced halt", () => {
  it("fails the drift task with a typed reason", async () => {
    const record = await run("settlement-drift", "advertised-enforced");
    expect(record.metrics.driftDetected).toBe(true);
    expect(record.metrics.halted).toBe(true);
    expect(record.metrics.correctHalt).toBe(true);
    expect(record.metrics.falseHalt).toBe(false);
    expect(record.finalTaskState).toBe("failed");
    expect(record.metrics.failureReason).toBe(SEMANTIC_MISMATCH_REASON);
    expect(record.metrics.taskSuccess).toBe(true);
    const halt = record.events.find((event) => event.type === "halt");
    expect(halt?.details["reason"]).toBe(SEMANTIC_MISMATCH_REASON);
  });

  it("does not false-halt a no-drift control", async () => {
    const record = await run("settlement-clean", "advertised-enforced");
    expect(record.metrics.driftDetected).toBe(false);
    expect(record.metrics.halted).toBe(false);
    expect(record.metrics.falseHalt).toBe(false);
    expect(record.finalTaskState).toBe("completed");
    expect(record.metrics.taskSuccess).toBe(true);
  });
});

describe("voluntary vs enforced are distinguishable on the same drift", () => {
  it("both detect, but only enforced halts", async () => {
    const voluntary = await run("bridge-drift", "advertised-voluntary");
    const enforced = await run("bridge-drift", "advertised-enforced");
    expect(voluntary.metrics.driftDetected).toBe(true);
    expect(enforced.metrics.driftDetected).toBe(true);
    expect(voluntary.metrics.halted).toBe(false);
    expect(enforced.metrics.halted).toBe(true);
    expect(voluntary.finalTaskState).toBe("completed");
    expect(enforced.finalTaskState).toBe("failed");
  });
});

describe("wire and hydration accounting", () => {
  it("extension conditions add wire bytes; hydration is unchanged across conditions", async () => {
    const baseline = await run("settlement-drift", "baseline");
    const enforced = await run("settlement-drift", "advertised-enforced");
    // The acceptance contract with content-addressed references costs wire bytes.
    expect(enforced.metrics.wireBytes).toBeGreaterThan(
      baseline.metrics.wireBytes,
    );
    // The worker resolves the same definitions from its registry regardless of
    // condition, so hydration bytes are identical — drift always sits here.
    expect(enforced.metrics.hydrationBytes).toBe(
      baseline.metrics.hydrationBytes,
    );
    expect(enforced.metrics.totalSemanticBytes).toBe(
      enforced.metrics.wireBytes + enforced.metrics.hydrationBytes,
    );
  });
});

describe("record shape", () => {
  it("produces schema-valid records with null usage/transcript and captured cards", async () => {
    const record = await run("payment-drift", "advertised-enforced");
    expect(a2aDriftTrialRecordSchema.safeParse(record).success).toBe(true);
    expect(record.usage).toBeNull();
    expect(record.transcript).toBeNull();
    expect(record.requesterCard.capabilities.extensions).toHaveLength(1);
    expect(record.workerCard.capabilities.extensions).toHaveLength(1);
  });

  it("is deterministic across repetition seeds (zero within-condition variance)", async () => {
    const scenario = await scenarioById("escrow-drift");
    const seedCell = (seed: number) =>
      planPairedMatrix({
        experimentId: "a2a-drift",
        protocolVersion: PROTOCOL_VERSION,
        scenarios: [scenario],
        scenarioId: (value) => value.id,
        conditions: ["advertised-enforced"] as A2aDriftCondition[],
        seeds: [seed],
        orderSeed: 1,
      })[0];
    const a = seedCell(0);
    const b = seedCell(1);
    if (!a || !b) {
      throw new Error("Expected cells.");
    }
    const opts = {
      experimentId: "a2a-drift",
      referenceProvider: new FixtureReferenceProvider(),
      vocabularyRoot: "",
      provenance,
    };
    const ra = await runA2aDriftTrial(a, opts);
    const rb = await runA2aDriftTrial(b, opts);
    expect(ra.metrics.driftDetected).toBe(rb.metrics.driftDetected);
    expect(ra.metrics.halted).toBe(rb.metrics.halted);
    expect(ra.metrics.wireBytes).toBe(rb.metrics.wireBytes);
    expect(ra.finalTaskState).toBe(rb.finalTaskState);
  });
});
