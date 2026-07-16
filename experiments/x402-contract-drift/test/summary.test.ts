import { describe, expect, it } from "vitest";

import {
  summarizeX402Drift,
  x402DriftSummaryMarkdown,
} from "../src/summary.js";
import {
  x402DriftTrialRecordSchema,
  type PaymentState,
  type X402DriftCondition,
  type X402DriftMetrics,
  type X402DriftTrialRecord,
} from "../src/schemas.js";

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
  modelName: "x402-contract-drift-demo-v1",
};

const requirements = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "1000",
  asset: "0xasset",
  payTo: "0xpayto",
  resource: "https://api.example.com/r",
  description: "d",
  maxTimeoutSeconds: 60,
};

let counter = 0;

function record(
  condition: X402DriftCondition,
  driftInjected: boolean,
  overrides: Partial<X402DriftMetrics>,
  finalPaymentState: PaymentState,
): X402DriftTrialRecord {
  counter += 1;
  const metrics: X402DriftMetrics = {
    driftInjected,
    extensionAdvertised: condition !== "baseline",
    referencesCarried: condition !== "baseline",
    verificationPerformed: condition !== "baseline",
    referencesChecked: 0,
    referencesMatched: 0,
    referencesMismatched: 0,
    driftDetected: false,
    paid: finalPaymentState === "paid",
    halted: false,
    silentPayment: false,
    correctHalt: false,
    falseHalt: false,
    taskSuccess: false,
    finalPaymentState,
    failureReason: null,
    wireBytes: 100,
    hydrationBytes: 200,
    totalSemanticBytes: 300,
    elapsedMs: 1,
    ...overrides,
  };
  return x402DriftTrialRecordSchema.parse({
    trialId: counter.toString(16).padStart(64, "0"),
    experimentId: "x402-contract-drift",
    scenarioId: `${condition}-${driftInjected ? "drift" : "clean"}-${counter}`,
    condition,
    seed: 0,
    executionIndex: counter,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    driftInjected,
    finalPaymentState,
    paymentRequirements: requirements,
    paymentPayload: null,
    settlement: null,
    events: [],
    metrics,
    provenance,
    usage: null,
    transcript: null,
  });
}

describe("summarizeX402Drift math", () => {
  it("computes detection, silent-payment, false-refusal, and task-success rates over the right denominators", () => {
    const records: X402DriftTrialRecord[] = [
      record(
        "advertised-enforced",
        true,
        {
          driftDetected: true,
          halted: true,
          paid: false,
          correctHalt: true,
          taskSuccess: true,
          referencesMismatched: 1,
        },
        "refused",
      ),
      record(
        "advertised-enforced",
        true,
        {
          driftDetected: true,
          halted: true,
          paid: false,
          correctHalt: true,
          taskSuccess: true,
          referencesMismatched: 1,
        },
        "refused",
      ),
      record("advertised-enforced", false, { taskSuccess: true }, "paid"),
      record("advertised-enforced", false, { taskSuccess: true }, "paid"),
    ];
    const summary = summarizeX402Drift(records);
    const enforced = summary.conditions[0];
    expect(enforced?.condition).toBe("advertised-enforced");
    expect(enforced?.trials).toBe(4);
    expect(enforced?.driftTrials).toBe(2);
    expect(enforced?.cleanTrials).toBe(2);
    expect(enforced?.detectionRate).toBe(1);
    expect(enforced?.silentPaymentRate).toBe(0);
    expect(enforced?.falseHalts).toBe(0);
    expect(enforced?.falseHaltRate).toBe(0);
    expect(enforced?.taskSuccessRate).toBe(1);
    expect(enforced?.meanWireBytes).toBe(100);
    expect(enforced?.meanHydrationBytes).toBe(200);
    expect(summary.driftScenarioCount).toBe(2);
    expect(summary.cleanScenarioCount).toBe(2);
  });

  it("counts a baseline silent payment and reports zero-denominator rates as zero", () => {
    const records = [
      record(
        "baseline",
        true,
        { silentPayment: true, paid: true, taskSuccess: false },
        "paid",
      ),
    ];
    const summary = summarizeX402Drift(records);
    const baseline = summary.conditions[0];
    expect(baseline?.silentPaymentRate).toBe(1);
    expect(baseline?.detectionRate).toBe(0);
    expect(baseline?.cleanTrials).toBe(0);
    expect(baseline?.falseHaltRate).toBe(0);
  });

  it("renders a markdown table with a row per present condition", () => {
    const records = [
      record("baseline", true, { silentPayment: true, paid: true }, "paid"),
      record(
        "advertised-enforced",
        true,
        { driftDetected: true, halted: true, paid: false, correctHalt: true },
        "refused",
      ),
    ];
    const markdown = x402DriftSummaryMarkdown(summarizeX402Drift(records));
    expect(markdown).toContain("# x402 payment-contract drift summary");
    expect(markdown).toContain("baseline");
    expect(markdown).toContain("advertised-enforced");
    expect(markdown).toContain("Harness validation only");
  });
});
