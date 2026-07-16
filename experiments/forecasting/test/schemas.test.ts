import { describe, expect, it } from "vitest";

import { buildForecastObject } from "../src/agents.js";
import { FixtureReferenceProvider } from "@sema-evals/adapters";

import { buildAgentRegistry } from "../src/registry.js";
import {
  COORDINATION_HANDLES,
  forecastObjectSchema,
  forecastingQuestionSchema,
  forecastingScenarioSchema,
  forecastingTrialRecordSchema,
  leakageAuditDocumentSchema,
  leakageAuditEntrySchema,
  type ForecastingScenario,
} from "../src/schemas.js";

const SCENARIO: ForecastingScenario = {
  id: "synthetic-unit-scenario",
  title: "Unit scenario",
  description: "For schema round-trip tests.",
  question: {
    questionText: "Will event E occur by date D?",
    resolutionCriteria: "Resolves YES if event E is recorded by date D.",
    resolutionTimestamp: "2024-07-01T00:00:00.000Z",
    resolvedOutcome: "YES",
    marketPrior: 0.5,
    evidencePack: null,
  },
  leakageAudit: {
    model: "synthetic-auditor-v1",
    zeroEvidenceAnswer: "YES",
    confidence: 0.7,
    verdict: "keep",
  },
  patterns: [
    {
      handle: "ResolutionDefinition",
      definition: { anchor: "announced", deadline: "2024-06-30T23:59:59.000Z" },
    },
    {
      handle: "EvidenceCutoff",
      definition: { cutoff: "2024-06-30T23:59:59.000Z", timezone: "UTC" },
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
  ],
  coordinationHandles: [...COORDINATION_HANDLES],
  agents: [
    { id: "forecaster-0", round1Probability: 0.4, round2Probability: 0.45 },
    { id: "forecaster-1", round1Probability: 0.5, round2Probability: 0.55 },
  ],
  drift: null,
};

describe("schema round-trips", () => {
  it("round-trips a synthetic Polymarket-style question with null evidencePack", () => {
    const parsed = forecastingQuestionSchema.parse(SCENARIO.question);
    expect(parsed.evidencePack).toBeNull();
    expect(parsed.resolvedOutcome).toBe("YES");
    expect(parsed.marketPrior).toBe(0.5);
  });

  it("round-trips a leakage audit entry and document", () => {
    const entry = leakageAuditEntrySchema.parse(SCENARIO.leakageAudit);
    expect(entry.verdict).toBe("keep");
    const document = leakageAuditDocumentSchema.parse({
      schemaVersion: "0.1.0",
      entries: [{ scenarioId: SCENARIO.id, audit: entry }],
    });
    expect(document.entries).toHaveLength(1);
  });

  it("round-trips a full scenario fixture", () => {
    const parsed = forecastingScenarioSchema.parse(SCENARIO);
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.coordinationHandles).toEqual([...COORDINATION_HANDLES]);
  });

  it("round-trips forecast objects under baseline and addressed conditions", async () => {
    const provider = new FixtureReferenceProvider();
    const registry = buildAgentRegistry(SCENARIO, "forecaster-0");
    const baseline = await buildForecastObject({
      scenario: SCENARIO,
      agentId: "forecaster-0",
      round: 1,
      probability: 0.4,
      condition: "baseline",
      registry,
      referenceProvider: provider,
    });
    expect(forecastObjectSchema.parse(baseline).citedReferences).toHaveLength(
      0,
    );

    const addressed = await buildForecastObject({
      scenario: SCENARIO,
      agentId: "forecaster-0",
      round: 2,
      probability: 0.45,
      condition: "addressed-enforced",
      registry,
      referenceProvider: provider,
    });
    const parsed = forecastObjectSchema.parse(addressed);
    expect(parsed.citedReferences).toHaveLength(4);
    expect(parsed.citedReferences[0]?.digest).toHaveLength(64);
  });

  it("rejects a scenario whose drift handle is not in coordinationHandles", () => {
    expect(() =>
      forecastingScenarioSchema.parse({
        ...SCENARIO,
        coordinationHandles: ["ResolutionDefinition", "EvidenceCutoff"],
        drift: {
          agentId: "forecaster-0",
          handle: "ProbabilityFormat",
          fieldPath: "scale",
          before: "unit",
          after: "percent",
          mutatedDefinition: { scale: "percent", minimum: 0, maximum: 100 },
        },
      }),
    ).toThrow();
  });
});

describe("trial record schema", () => {
  it("exports a parseable schema object", () => {
    expect(typeof forecastingTrialRecordSchema.parse).toBe("function");
  });
});
