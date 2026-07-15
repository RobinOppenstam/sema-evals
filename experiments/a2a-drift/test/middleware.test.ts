import { FixtureReferenceProvider } from "@sema-evals/adapters";
import { describe, expect, it } from "vitest";

import { buildRequiredReferences } from "../src/agents.js";
import {
  SEMANTIC_MISMATCH_REASON,
  applyEnforcement,
  verifyAcceptanceContract,
  type VerificationResult,
} from "../src/middleware.js";
import {
  buildRequesterRegistry,
  buildWorkerRegistry,
} from "../src/registry.js";
import {
  SEMANTIC_EXTENSION_URI,
  type A2aDriftScenario,
  type AcceptanceContract,
} from "../src/schemas.js";

const provider = new FixtureReferenceProvider();

const DRIFT_SCENARIO: A2aDriftScenario = {
  id: "mw-drift",
  title: "mw drift",
  description: "drift scenario",
  task: "task",
  patterns: [
    { handle: "Alpha", definition: { comparator: "<=", threshold: 50 } },
    { handle: "Beta", definition: { comparator: ">=", threshold: 2 } },
  ],
  acceptanceHandles: ["Alpha", "Beta"],
  drift: {
    handle: "Alpha",
    fieldPath: "threshold",
    before: 50,
    after: 150,
    mutatedDefinition: { comparator: "<=", threshold: 150 },
  },
};

const CLEAN_SCENARIO: A2aDriftScenario = {
  ...DRIFT_SCENARIO,
  id: "mw-clean",
  drift: null,
};

async function contractFor(
  scenario: A2aDriftScenario,
  enforcement: "voluntary" | "enforced",
): Promise<AcceptanceContract> {
  const references = await buildRequiredReferences(
    scenario,
    buildRequesterRegistry(scenario),
    provider,
  );
  return {
    contractId: "c",
    extensionUri: SEMANTIC_EXTENSION_URI,
    enforcement,
    requiredReferences: references,
  };
}

describe("verifyAcceptanceContract", () => {
  it("matches every reference when registries are aligned (no-drift)", async () => {
    const contract = await contractFor(CLEAN_SCENARIO, "enforced");
    const result = await verifyAcceptanceContract(
      contract,
      buildWorkerRegistry(CLEAN_SCENARIO),
      provider,
    );
    expect(result.referencesChecked).toBe(2);
    expect(result.referencesMatched).toBe(2);
    expect(result.referencesMismatched).toBe(0);
    expect(result.driftDetected).toBe(false);
  });

  it("detects a mismatch on exactly the drifted handle", async () => {
    const contract = await contractFor(DRIFT_SCENARIO, "enforced");
    const result = await verifyAcceptanceContract(
      contract,
      buildWorkerRegistry(DRIFT_SCENARIO),
      provider,
    );
    expect(result.driftDetected).toBe(true);
    expect(result.referencesMismatched).toBe(1);
    const mismatched = result.checks.filter((check) => !check.matched);
    expect(mismatched.map((check) => check.handle)).toEqual(["Alpha"]);
    // The undrifted handle still matches.
    const beta = result.checks.find((check) => check.handle === "Beta");
    expect(beta?.matched).toBe(true);
  });
});

describe("applyEnforcement transition rules", () => {
  const detected: VerificationResult = {
    checks: [],
    referencesChecked: 1,
    referencesMatched: 0,
    referencesMismatched: 1,
    driftDetected: true,
  };
  const clean: VerificationResult = {
    checks: [],
    referencesChecked: 2,
    referencesMatched: 2,
    referencesMismatched: 0,
    driftDetected: false,
  };

  it("enforced + mismatch fails the task with a typed reason", () => {
    const decision = applyEnforcement(detected, "enforced");
    expect(decision.terminalState).toBe("failed");
    expect(decision.halted).toBe(true);
    expect(decision.failureReason).toBe(SEMANTIC_MISMATCH_REASON);
  });

  it("enforced + all match completes the task (no false halt)", () => {
    const decision = applyEnforcement(clean, "enforced");
    expect(decision.terminalState).toBe("completed");
    expect(decision.halted).toBe(false);
    expect(decision.failureReason).toBeNull();
  });

  it("voluntary + mismatch still completes (verdict is advisory)", () => {
    const decision = applyEnforcement(detected, "voluntary");
    expect(decision.terminalState).toBe("completed");
    expect(decision.halted).toBe(false);
    expect(decision.failureReason).toBeNull();
  });

  it("voluntary + all match completes", () => {
    const decision = applyEnforcement(clean, "voluntary");
    expect(decision.terminalState).toBe("completed");
    expect(decision.halted).toBe(false);
  });
});

describe("false-halt guard", () => {
  it("an enforced worker never halts a no-drift control", async () => {
    const contract = await contractFor(CLEAN_SCENARIO, "enforced");
    const result = await verifyAcceptanceContract(
      contract,
      buildWorkerRegistry(CLEAN_SCENARIO),
      provider,
    );
    const decision = applyEnforcement(result, "enforced");
    expect(decision.halted).toBe(false);
    expect(decision.terminalState).toBe("completed");
  });
});
