import { describe, expect, it } from "vitest";

import { a2aDriftSummaryMarkdown, summarizeA2aDrift } from "../src/summary.js";
import {
  a2aDriftTrialRecordSchema,
  type A2aDriftCondition,
  type A2aDriftMetrics,
  type A2aDriftTrialRecord,
  type TaskState,
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
  modelName: "a2a-drift-demo-v1",
};

const card = {
  protocolVersion: "0.3.0",
  name: "n",
  description: "d",
  url: "u",
  version: "0.1.0",
  capabilities: { streaming: false, pushNotifications: false, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "s", name: "s", description: "s" }],
};

let counter = 0;

function record(
  condition: A2aDriftCondition,
  driftInjected: boolean,
  overrides: Partial<A2aDriftMetrics>,
  finalTaskState: TaskState,
): A2aDriftTrialRecord {
  counter += 1;
  const metrics: A2aDriftMetrics = {
    driftInjected,
    extensionAdvertised: condition !== "baseline",
    referencesCarried: condition !== "baseline",
    verificationPerformed: condition !== "baseline",
    referencesChecked: 0,
    referencesMatched: 0,
    referencesMismatched: 0,
    driftDetected: false,
    halted: false,
    silentExecution: false,
    correctHalt: false,
    falseHalt: false,
    taskSuccess: false,
    finalTaskState,
    failureReason: null,
    wireBytes: 100,
    hydrationBytes: 200,
    totalSemanticBytes: 300,
    elapsedMs: 1,
    ...overrides,
  };
  return a2aDriftTrialRecordSchema.parse({
    trialId: counter.toString(16).padStart(64, "0"),
    experimentId: "a2a-drift",
    scenarioId: `${condition}-${driftInjected ? "drift" : "clean"}-${counter}`,
    condition,
    seed: 0,
    executionIndex: counter,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    driftInjected,
    finalTaskState,
    requesterCard: card,
    workerCard: card,
    events: [],
    metrics,
    provenance,
    usage: null,
    transcript: null,
  });
}

describe("summarizeA2aDrift math", () => {
  it("computes detection, silent-execution, false-halt, and task-success rates over the right denominators", () => {
    const records: A2aDriftTrialRecord[] = [
      // enforced, 2 drift trials both detected+halted, 2 clean trials completed.
      record(
        "advertised-enforced",
        true,
        {
          driftDetected: true,
          halted: true,
          correctHalt: true,
          taskSuccess: true,
          referencesMismatched: 1,
        },
        "failed",
      ),
      record(
        "advertised-enforced",
        true,
        {
          driftDetected: true,
          halted: true,
          correctHalt: true,
          taskSuccess: true,
          referencesMismatched: 1,
        },
        "failed",
      ),
      record("advertised-enforced", false, { taskSuccess: true }, "completed"),
      record("advertised-enforced", false, { taskSuccess: true }, "completed"),
    ];
    const summary = summarizeA2aDrift(records);
    const enforced = summary.conditions[0];
    expect(enforced?.condition).toBe("advertised-enforced");
    expect(enforced?.trials).toBe(4);
    expect(enforced?.driftTrials).toBe(2);
    expect(enforced?.cleanTrials).toBe(2);
    // detection and silent rates are over the 2 drift trials.
    expect(enforced?.detectionRate).toBe(1);
    expect(enforced?.silentExecutionRate).toBe(0);
    // false-halt rate is over the 2 clean trials.
    expect(enforced?.falseHalts).toBe(0);
    expect(enforced?.falseHaltRate).toBe(0);
    // task success is over all 4 trials.
    expect(enforced?.taskSuccessRate).toBe(1);
    expect(enforced?.meanWireBytes).toBe(100);
    expect(enforced?.meanHydrationBytes).toBe(200);
    expect(summary.driftScenarioCount).toBe(2);
    expect(summary.cleanScenarioCount).toBe(2);
  });

  it("counts a baseline silent divergence and reports zero-denominator rates as zero", () => {
    const records = [
      record(
        "baseline",
        true,
        { silentExecution: true, taskSuccess: false },
        "completed",
      ),
    ];
    const summary = summarizeA2aDrift(records);
    const baseline = summary.conditions[0];
    expect(baseline?.silentExecutionRate).toBe(1);
    expect(baseline?.detectionRate).toBe(0);
    // No clean trials -> false-halt rate is a safe zero, not NaN.
    expect(baseline?.cleanTrials).toBe(0);
    expect(baseline?.falseHaltRate).toBe(0);
  });

  it("renders a markdown table with a row per present condition", () => {
    const records = [
      record("baseline", true, { silentExecution: true }, "completed"),
      record(
        "advertised-enforced",
        true,
        { driftDetected: true, halted: true, correctHalt: true },
        "failed",
      ),
    ];
    const markdown = a2aDriftSummaryMarkdown(summarizeA2aDrift(records));
    expect(markdown).toContain("# A2A semantic-extension drift summary");
    expect(markdown).toContain("baseline");
    expect(markdown).toContain("advertised-enforced");
    expect(markdown).toContain("Harness validation only");
  });
});
