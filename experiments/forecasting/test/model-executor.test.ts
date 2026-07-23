import type {
  ModelAgentAdapter,
  ModelCompletion,
  ModelPromptInput,
} from "@sema-evals/adapters";
import { describe, expect, it } from "vitest";
import {
  executeForecastingCouncil,
  executeForecastingCouncilMember,
  forecastingModelReadinessGateSchema,
} from "../src/model-executor.js";

const adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion> = {
  descriptor: {
    id: "fake",
    provider: "fake",
    model: "fake",
    deterministic: true,
  },
  invoke: async () => ({
    output: {
      status: "completed",
      text: '{"agentId":"a","probability":0.6,"rationale":"evidence"}',
      stopReason: "end",
    },
    transcript: { entries: [] },
    usage: {
      inputTokens: 10,
      cachedInputTokensRead: 0,
      cachedInputTokensWritten: 0,
      reasoningTokens: null,
      outputTokens: 8,
      attempts: 1,
      retries: 0,
      errors: [],
      latencyMs: 1,
      stopReason: "end",
      costUsd: null,
    },
    elapsedMs: 1,
    raw: null,
  }),
};

describe("forecasting model executor", () => {
  it("preserves structured output, transcript, usage, and fingerprints", async () => {
    const result = await executeForecastingCouncilMember(
      adapter,
      {
        schemaVersion: "forecasting-model-readiness-v1",
        ready: true,
        realQuestionsReady: true,
        historicalProvenanceValidated: true,
        evidencePackValidated: true,
        leakageAuditComplete: true,
        modelConfigured: true,
        blockReasons: [],
      },
      {
        agentId: "a",
        question: "Will X happen?",
        resolutionCriteria: "YES if X",
        forecastCutoff: "2026-01-01T00:00:00Z",
      },
    );
    expect(result.parsedOutput?.probability).toBe(0.6);
    expect(result.requestFingerprint).toHaveLength(64);
    expect(result.usage?.inputTokens).toBe(10);
  });

  it("marks malformed members and rejects inconsistent readiness", async () => {
    expect(
      forecastingModelReadinessGateSchema.safeParse({
        schemaVersion: "forecasting-model-readiness-v1",
        ready: true,
        realQuestionsReady: false,
        historicalProvenanceValidated: true,
        evidencePackValidated: true,
        leakageAuditComplete: true,
        modelConfigured: true,
        blockReasons: [],
      }).success,
    ).toBe(false);
    const malformed = {
      ...adapter,
      invoke: async () => ({
        ...(await adapter.invoke({ messages: [] })),
        output: {
          status: "completed" as const,
          text: "bad",
          stopReason: "end",
        },
      }),
    };
    const council = await executeForecastingCouncil(
      malformed,
      {
        schemaVersion: "forecasting-model-readiness-v1",
        ready: true,
        realQuestionsReady: true,
        historicalProvenanceValidated: true,
        evidencePackValidated: true,
        leakageAuditComplete: true,
        modelConfigured: true,
        blockReasons: [],
      },
      [
        {
          agentId: "a",
          question: "q",
          resolutionCriteria: "r",
          forecastCutoff: "c",
        },
      ],
    );
    expect(council.status).toBe("malformed-output");
    expect(council.aggregateProbability).toBeNull();
  });
});
