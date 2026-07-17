import type {
  ModelAgentAdapter,
  ModelCompletion,
  ModelPromptInput,
} from "@sema-evals/adapters";
import { describe, expect, it } from "vitest";
import {
  executeX402PaperPayer,
  x402ModelReadinessGateSchema,
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
      text: '{"decision":"PAY_PAPER","reason":"contract matches"}',
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

describe("x402 model executor", () => {
  it("can only produce a paper decision and never attempts a production write", async () => {
    const result = await executeX402PaperPayer(
      adapter,
      {
        schemaVersion: "x402-model-readiness-v1",
        ready: true,
        paperReplayReady: true,
        modelConfigured: true,
        sdkConformanceReady: true,
        productionWritesDisabled: true,
        blockReasons: [],
      },
      { scenarioId: "s1", paymentRequired: { amount: "1" }, mode: "paper" },
    );
    expect(result.parsedDecision?.decision).toBe("PAY_PAPER");
    expect(result.productionWriteAttempted).toBe(false);
    expect(result.transcript).toEqual({ entries: [] });
  });

  it("rejects inconsistent readiness and marks malformed decisions", async () => {
    expect(
      x402ModelReadinessGateSchema.safeParse({
        schemaVersion: "x402-model-readiness-v1",
        ready: true,
        paperReplayReady: false,
        modelConfigured: true,
        sdkConformanceReady: true,
        productionWritesDisabled: true,
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
    const result = await executeX402PaperPayer(
      malformed,
      {
        schemaVersion: "x402-model-readiness-v1",
        ready: true,
        paperReplayReady: true,
        modelConfigured: true,
        sdkConformanceReady: true,
        productionWritesDisabled: true,
        blockReasons: [],
      },
      { scenarioId: "s", paymentRequired: {}, mode: "paper" },
    );
    expect(result.status).toBe("malformed-output");
  });
});
