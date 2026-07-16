import { describe, expect, it } from "vitest";

import {
  buildLeakageAuditDocument,
  evaluateLeakageAuditGate,
  evaluateLeakageAuditGateFromScenarios,
} from "../src/leakage.js";
import type { ForecastingScenario, LeakageAuditEntry } from "../src/schemas.js";

function scenario(id: string, audit: LeakageAuditEntry): ForecastingScenario {
  return {
    id,
    title: "t",
    description: "d",
    question: {
      questionText: "Will Q?",
      resolutionCriteria: "Resolves YES if Q.",
      resolutionTimestamp: "2024-07-01T00:00:00.000Z",
      resolvedOutcome: "YES",
      marketPrior: 0.5,
      evidencePack: null,
    },
    leakageAudit: audit,
    patterns: [
      { handle: "ResolutionDefinition", definition: { anchor: "a" } },
      { handle: "EvidenceCutoff", definition: { cutoff: "c" } },
      { handle: "ProbabilityFormat", definition: { scale: "unit" } },
      { handle: "AggregationRule", definition: { method: "probability_mean" } },
    ],
    coordinationHandles: [
      "ResolutionDefinition",
      "EvidenceCutoff",
      "ProbabilityFormat",
      "AggregationRule",
    ],
    agents: [
      { id: "forecaster-0", round1Probability: 0.5, round2Probability: 0.5 },
      { id: "forecaster-1", round1Probability: 0.5, round2Probability: 0.5 },
    ],
    drift: null,
  };
}

const KEEP: LeakageAuditEntry = {
  model: "synthetic-auditor-v1",
  zeroEvidenceAnswer: "YES",
  confidence: 0.7,
  verdict: "keep",
};

const DROP: LeakageAuditEntry = {
  ...KEEP,
  verdict: "drop",
};

describe("leakage audit gate", () => {
  it("passes when every included question has verdict keep", () => {
    const scenarios = [
      scenario("synthetic-a", KEEP),
      scenario("synthetic-b", KEEP),
    ];
    const gate = evaluateLeakageAuditGateFromScenarios(scenarios);
    expect(gate.passed).toBe(true);
    expect(gate.failures).toHaveLength(0);

    const document = buildLeakageAuditDocument(scenarios);
    expect(document.entries).toHaveLength(2);
  });

  it("fails when an audit entry is missing", () => {
    const scenarios = [scenario("synthetic-a", KEEP)];
    const audits = new Map<string, LeakageAuditEntry>();
    // Intentionally empty — missing entry for synthetic-a.
    const gate = evaluateLeakageAuditGate(scenarios, audits);
    expect(gate.passed).toBe(false);
    expect(gate.failures[0]).toMatch(/missing leakage audit entry/);
  });

  it("fails when an audit verdict is drop", () => {
    const scenarios = [scenario("synthetic-a", DROP)];
    const gate = evaluateLeakageAuditGateFromScenarios(scenarios);
    expect(gate.passed).toBe(false);
    expect(gate.failures[0]).toMatch(/verdict is drop/);
  });
});
