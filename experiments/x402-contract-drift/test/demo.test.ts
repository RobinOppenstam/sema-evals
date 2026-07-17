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

import { runX402DriftTrial } from "../src/demo.js";
import { loadFixtureFile } from "../src/fixtures.js";
import { SEMANTIC_MISMATCH_REASON } from "../src/middleware.js";
import {
  x402DriftTrialRecordSchema,
  type X402DriftCondition,
  type X402DriftScenario,
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
  modelName: "x402-contract-drift-demo-v2",
};

async function scenarioById(id: string): Promise<X402DriftScenario> {
  const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
  const scenario = fixtureSet.scenarios.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Expected scenario ${id}.`);
  }
  return scenario;
}

function cellFor(
  scenario: X402DriftScenario,
  condition: X402DriftCondition,
): MatrixCell<X402DriftScenario, X402DriftCondition> {
  const [cell] = planPairedMatrix({
    experimentId: "x402-contract-drift",
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

async function run(id: string, condition: X402DriftCondition) {
  const scenario = await scenarioById(id);
  return runX402DriftTrial(cellFor(scenario, condition), {
    experimentId: "x402-contract-drift",
    referenceProvider: new FixtureReferenceProvider(),
    vocabularyRoot: "",
    provenance,
  });
}

describe("baseline: silent payment under drift", () => {
  it("pays a drift scenario using the payer's drifted definition with no surfaced mismatch", async () => {
    const record = await run("refund-window-drift", "baseline");
    expect(record.metrics.driftInjected).toBe(true);
    expect(record.metrics.driftDetected).toBe(false);
    expect(record.metrics.paid).toBe(true);
    expect(record.metrics.silentPayment).toBe(true);
    expect(record.finalPaymentState).toBe("paid");
    expect(record.metrics.halted).toBe(false);
    expect(record.metrics.taskSuccess).toBe(false);
    expect(record.events.some((event) => event.type === "verification")).toBe(
      false,
    );
    expect(record.paymentPayload).not.toBeNull();
    expect(record.settlement?.success).toBe(true);
  });

  it("pays a no-drift control with no detection and task success", async () => {
    const record = await run("refund-window-clean", "baseline");
    expect(record.metrics.driftInjected).toBe(false);
    expect(record.metrics.silentPayment).toBe(false);
    expect(record.finalPaymentState).toBe("paid");
    expect(record.metrics.taskSuccess).toBe(true);
  });
});

describe("advertised-voluntary: detection without refusal", () => {
  it("detects the drift and surfaces it but still pays", async () => {
    const record = await run("refund-window-drift", "advertised-voluntary");
    expect(record.metrics.driftDetected).toBe(true);
    expect(record.metrics.silentPayment).toBe(false);
    expect(record.metrics.halted).toBe(false);
    expect(record.metrics.paid).toBe(true);
    expect(record.finalPaymentState).toBe("paid");
    expect(record.metrics.taskSuccess).toBe(false);
    expect(record.metrics.referencesMismatched).toBe(1);
    const verification = record.events.find(
      (event) => event.type === "verification",
    );
    expect(verification?.details["verdict"]).toBe("PAY");
  });
});

describe("advertised-enforced: enforced refusal", () => {
  it("refuses the drift payment with a typed reason", async () => {
    const record = await run("refund-window-drift", "advertised-enforced");
    expect(record.metrics.driftDetected).toBe(true);
    expect(record.metrics.halted).toBe(true);
    expect(record.metrics.paid).toBe(false);
    expect(record.metrics.correctHalt).toBe(true);
    expect(record.metrics.falseHalt).toBe(false);
    expect(record.finalPaymentState).toBe("refused");
    expect(record.metrics.failureReason).toBe(SEMANTIC_MISMATCH_REASON);
    expect(record.metrics.taskSuccess).toBe(true);
    expect(record.paymentPayload).toBeNull();
    expect(record.settlement).toBeNull();
    const halt = record.events.find((event) => event.type === "halt");
    expect(halt?.details["reason"]).toBe(SEMANTIC_MISMATCH_REASON);
  });

  it("does not false-refuse a no-drift control", async () => {
    const record = await run("refund-window-clean", "advertised-enforced");
    expect(record.metrics.driftDetected).toBe(false);
    expect(record.metrics.halted).toBe(false);
    expect(record.metrics.falseHalt).toBe(false);
    expect(record.metrics.paid).toBe(true);
    expect(record.finalPaymentState).toBe("paid");
    expect(record.metrics.taskSuccess).toBe(true);
  });
});

describe("voluntary vs enforced are distinguishable on the same drift", () => {
  it("both detect, but only enforced refuses", async () => {
    const voluntary = await run(
      "settlement-finality-drift",
      "advertised-voluntary",
    );
    const enforced = await run(
      "settlement-finality-drift",
      "advertised-enforced",
    );
    expect(voluntary.metrics.driftDetected).toBe(true);
    expect(enforced.metrics.driftDetected).toBe(true);
    expect(voluntary.metrics.halted).toBe(false);
    expect(enforced.metrics.halted).toBe(true);
    expect(voluntary.metrics.paid).toBe(true);
    expect(enforced.metrics.paid).toBe(false);
    expect(voluntary.finalPaymentState).toBe("paid");
    expect(enforced.finalPaymentState).toBe("refused");
  });
});

describe("wire and hydration accounting", () => {
  it("extension conditions add wire bytes; hydration is unchanged across conditions", async () => {
    const baseline = await run("refund-window-drift", "baseline");
    const enforced = await run("refund-window-drift", "advertised-enforced");
    // Enforced refuses, so it does not emit payment/settlement wire — but the
    // 402 requirements with the acceptance contract still cost more than
    // baseline's requirements-only envelope when comparing requirement size.
    // Compare hydration: same definitions resolved either way.
    expect(enforced.metrics.hydrationBytes).toBe(
      baseline.metrics.hydrationBytes,
    );
    expect(enforced.metrics.totalSemanticBytes).toBe(
      enforced.metrics.wireBytes + enforced.metrics.hydrationBytes,
    );

    const voluntary = await run("refund-window-drift", "advertised-voluntary");
    // Voluntary pays and carries the contract — more wire than baseline.
    expect(voluntary.metrics.wireBytes).toBeGreaterThan(
      baseline.metrics.wireBytes,
    );
  });
});

describe("record shape", () => {
  it("produces schema-valid records with null usage/transcript", async () => {
    const record = await run("amount-basis-drift", "advertised-enforced");
    expect(x402DriftTrialRecordSchema.safeParse(record).success).toBe(true);
    expect(record.usage).toBeNull();
    expect(record.transcript).toBeNull();
    expect(
      record.paymentRequired.extensions[
        "https://sema-evals.dev/x402/ext/semantic-canonicalization/v0.1"
      ],
    ).toBeDefined();
  });

  it("is deterministic across repetition seeds (zero within-condition variance)", async () => {
    const scenario = await scenarioById("fee-bearer-drift");
    const seedCell = (seed: number) =>
      planPairedMatrix({
        experimentId: "x402-contract-drift",
        protocolVersion: PROTOCOL_VERSION,
        scenarios: [scenario],
        scenarioId: (value) => value.id,
        conditions: ["advertised-enforced"] as X402DriftCondition[],
        seeds: [seed],
        orderSeed: 1,
      })[0];
    const a = seedCell(0);
    const b = seedCell(1);
    if (!a || !b) {
      throw new Error("Expected cells.");
    }
    const opts = {
      experimentId: "x402-contract-drift",
      referenceProvider: new FixtureReferenceProvider(),
      vocabularyRoot: "",
      provenance,
    };
    const ra = await runX402DriftTrial(a, opts);
    const rb = await runX402DriftTrial(b, opts);
    expect(ra.metrics.driftDetected).toBe(rb.metrics.driftDetected);
    expect(ra.metrics.halted).toBe(rb.metrics.halted);
    expect(ra.metrics.wireBytes).toBe(rb.metrics.wireBytes);
    expect(ra.finalPaymentState).toBe(rb.finalPaymentState);
  });
});
