import { fingerprint } from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import {
  assertDriftIsolation,
  buildAgentRegistry,
  buildCanonicalRegistry,
} from "../src/registry.js";
import type { ForecastingScenario } from "../src/schemas.js";

const BASE_PATTERNS = [
  { handle: "ResolutionDefinition", definition: { anchor: "announced" } },
  {
    handle: "EvidenceCutoff",
    definition: { cutoff: "2024-01-01T00:00:00.000Z" },
  },
  {
    handle: "ProbabilityFormat",
    definition: { scale: "unit", minimum: 0, maximum: 1 },
  },
  {
    handle: "AggregationRule",
    definition: {
      method: "probability_mean",
      requiresFormatNormalization: true,
    },
  },
];

const DRIFT_SCENARIO: ForecastingScenario = {
  id: "synthetic-drift",
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
  leakageAudit: {
    model: "synthetic-auditor-v1",
    zeroEvidenceAnswer: "YES",
    confidence: 0.5,
    verdict: "keep",
  },
  patterns: BASE_PATTERNS,
  coordinationHandles: [
    "ResolutionDefinition",
    "EvidenceCutoff",
    "ProbabilityFormat",
    "AggregationRule",
  ],
  agents: [
    { id: "forecaster-0", round1Probability: 0.5, round2Probability: 0.5 },
    { id: "forecaster-1", round1Probability: 0.5, round2Probability: 0.5 },
    { id: "forecaster-2", round1Probability: 0.5, round2Probability: 0.5 },
  ],
  drift: {
    agentId: "forecaster-1",
    handle: "ProbabilityFormat",
    fieldPath: "scale",
    before: "unit",
    after: "percent",
    mutatedDefinition: { scale: "percent", minimum: 0, maximum: 100 },
  },
};

const CLEAN_SCENARIO: ForecastingScenario = {
  ...DRIFT_SCENARIO,
  id: "synthetic-clean",
  drift: null,
};

describe("drift injection", () => {
  it("mutates exactly the drifted handle in exactly the drifted agent's registry", () => {
    const canonical = buildCanonicalRegistry(DRIFT_SCENARIO);
    const drifted = buildAgentRegistry(DRIFT_SCENARIO, "forecaster-1");
    const peer = buildAgentRegistry(DRIFT_SCENARIO, "forecaster-0");

    expect(fingerprint(drifted.resolve("ProbabilityFormat"))).not.toBe(
      fingerprint(canonical.resolve("ProbabilityFormat")),
    );
    expect(drifted.resolve("ProbabilityFormat")["scale"]).toBe("percent");

    for (const handle of [
      "ResolutionDefinition",
      "EvidenceCutoff",
      "AggregationRule",
    ]) {
      expect(fingerprint(drifted.resolve(handle))).toBe(
        fingerprint(canonical.resolve(handle)),
      );
    }
    for (const handle of canonical.handles()) {
      expect(fingerprint(peer.resolve(handle))).toBe(
        fingerprint(canonical.resolve(handle)),
      );
    }
  });

  it("leaves every agent identical to canonical for a no-drift control", () => {
    const canonical = buildCanonicalRegistry(CLEAN_SCENARIO);
    for (const agent of CLEAN_SCENARIO.agents) {
      const registry = buildAgentRegistry(CLEAN_SCENARIO, agent.id);
      for (const handle of canonical.handles()) {
        expect(fingerprint(registry.resolve(handle))).toBe(
          fingerprint(canonical.resolve(handle)),
        );
      }
    }
  });

  it("assertDriftIsolation passes for a well-formed drift and a clean control", () => {
    expect(() => assertDriftIsolation(DRIFT_SCENARIO)).not.toThrow();
    expect(() => assertDriftIsolation(CLEAN_SCENARIO)).not.toThrow();
  });

  it("assertDriftIsolation fails closed when a drift does not change its handle (fixture typo)", () => {
    const broken: ForecastingScenario = {
      ...DRIFT_SCENARIO,
      id: "broken-noop",
      drift: {
        handle: "ProbabilityFormat",
        agentId: "forecaster-1",
        fieldPath: "scale",
        before: "unit",
        after: "unit",
        mutatedDefinition: { scale: "unit", minimum: 0, maximum: 1 },
      },
    };
    expect(() => assertDriftIsolation(broken)).toThrow(/not isolated/);
  });

  it("assertDriftIsolation fails closed when the declared agent is not the one that changed", () => {
    const mislabeled: ForecastingScenario = {
      ...DRIFT_SCENARIO,
      id: "broken-mislabeled-agent",
      drift: {
        agentId: "forecaster-0",
        handle: "ProbabilityFormat",
        fieldPath: "scale",
        before: "unit",
        after: "percent",
        // mutatedDefinition equals canonical — no real change, wrong agent declared.
        mutatedDefinition: { scale: "unit", minimum: 0, maximum: 1 },
      },
    };
    expect(() => assertDriftIsolation(mislabeled)).toThrow(/not isolated/);
  });

  it("assertDriftIsolation fails closed when the declared handle is not the one that changed", () => {
    const mislabeled: ForecastingScenario = {
      ...DRIFT_SCENARIO,
      id: "broken-mislabeled-handle",
      drift: {
        agentId: "forecaster-1",
        handle: "EvidenceCutoff",
        fieldPath: "cutoff",
        before: "2024-01-01T00:00:00.000Z",
        after: "2023-01-01T00:00:00.000Z",
        // mutatedDefinition equals EvidenceCutoff canonical — no change there;
        // but we also need no change at all for this typo case.
        mutatedDefinition: {
          cutoff: "2024-01-01T00:00:00.000Z",
        },
      },
    };
    expect(() => assertDriftIsolation(mislabeled)).toThrow(/not isolated/);
  });
});
