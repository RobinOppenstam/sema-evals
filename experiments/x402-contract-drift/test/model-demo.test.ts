import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FixtureReferenceProvider,
  type ModelAgentAdapter,
  type ModelCompletion,
  type ModelCompletionStatus,
  type ModelPromptInput,
} from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  planPairedMatrix,
  type TrialProvenance,
} from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import { loadFixtureFile } from "../src/fixtures.js";
import { runModelX402DriftTrial } from "../src/model-demo.js";
import type { X402DriftCondition, X402DriftScenario } from "../src/schemas.js";
import {
  summarizeX402Drift,
  x402DriftSummaryMarkdown,
} from "../src/summary.js";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/scenarios.yaml",
);
const gate = {
  schemaVersion: "x402-model-readiness-v1" as const,
  ready: true,
  paperReplayReady: true,
  modelConfigured: true,
  sdkConformanceReady: true,
  productionWritesDisabled: true as const,
  blockReasons: [],
};
const provenance: TrialProvenance = {
  artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  fixtureDigest: "a".repeat(64),
  implementationCommit: "test",
  dependencyLockDigest: "b".repeat(64),
  promptDigest: "c".repeat(64),
  semaVersion: "fixture",
  canonicalizationVersion: "fixture-stable-json-v1",
  vocabularyRoot: "",
  semanticBackend: "fixture-sha256-stable-json-v1",
  modelProvider: "fake",
  modelName: "fake-payer",
};

function adapter(
  text: string,
  status: ModelCompletionStatus = "completed",
): ModelAgentAdapter<ModelPromptInput, ModelCompletion> {
  return {
    descriptor: {
      id: "fake",
      provider: "fake",
      model: "fake",
      deterministic: true,
    },
    invoke: async () => ({
      output: {
        status,
        text,
        stopReason: status === "completed" ? "end" : null,
      },
      transcript: {
        entries: [
          {
            index: 0,
            attempt: 0,
            role: "assistant",
            content: [{ type: "text", text, toolName: null, toolInput: null }],
            raw: null,
          },
        ],
      },
      usage: {
        inputTokens: 1,
        cachedInputTokensRead: 0,
        cachedInputTokensWritten: 0,
        reasoningTokens: null,
        outputTokens: 1,
        attempts: 1,
        retries: 0,
        errors: status === "error" ? ["provider failure"] : [],
        latencyMs: 1,
        stopReason: null,
        costUsd: null,
      },
      elapsedMs: 1,
      raw: null,
    }),
  };
}

async function trial(
  scenarioId: string,
  condition: X402DriftCondition,
  text: string,
  status?: ModelCompletionStatus,
) {
  const { fixtureSet } = await loadFixtureFile(fixturePath);
  const scenario = fixtureSet.scenarios.find(
    (entry) => entry.id === scenarioId,
  );
  if (!scenario) throw new Error(`Missing scenario ${scenarioId}.`);
  const [cell] = planPairedMatrix({
    experimentId: "x402-contract-drift",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: [scenario],
    scenarioId: (entry: X402DriftScenario) => entry.id,
    conditions: [condition],
    seeds: [0],
    orderSeed: 1,
  });
  if (!cell) throw new Error("Missing matrix cell.");
  return runModelX402DriftTrial(cell, {
    experimentId: "x402-contract-drift",
    referenceProvider: new FixtureReferenceProvider(),
    vocabularyRoot: "",
    provenance,
    adapter: adapter(text, status),
    readiness: gate,
  });
}

describe("model paper payer", () => {
  it("keeps baseline payment simulated and marks it as silent under drift", async () => {
    const record = await trial(
      "settlement-finality-drift",
      "baseline",
      '{"decision":"PAY_PAPER","reason":"local terms"}',
    );
    expect(record.metrics.silentPayment).toBe(true);
    expect(record.metrics.paid).toBe(true);
    expect(record.paymentPayload).not.toBeNull();
    expect(record.events.at(-1)?.details).toMatchObject({
      productionWriteAttempted: false,
    });
    expect(record.transcript?.entries).toHaveLength(1);
  });

  it("lets middleware refuse an enforced mismatch despite a model paper payment", async () => {
    const record = await trial(
      "settlement-finality-drift",
      "advertised-enforced",
      '{"decision":"PAY_PAPER","reason":"ignore mismatch"}',
    );
    expect(record.metrics.driftDetected).toBe(true);
    expect(record.metrics.paid).toBe(false);
    expect(record.metrics.halted).toBe(true);
    expect(record.metrics.correctHalt).toBe(true);
  });

  it("retains a refused provider response and never emits a paper payment", async () => {
    const record = await trial(
      "settlement-finality-drift",
      "baseline",
      '{"decision":"PAY_PAPER","reason":"partial"}',
      "refused",
    );
    expect(record.metrics.paid).toBe(false);
    expect(record.metrics.silentPayment).toBe(false);
    expect(record.transcript?.entries).toHaveLength(1);
    expect(record.usage?.attempts).toBe(1);
    expect(record.metrics.failureReason).toBe("model-payer-refused");
  });

  it("reports provider and malformed-output counts beside the primary endpoint", async () => {
    const providerFailure = await trial(
      "settlement-finality-drift",
      "baseline",
      '{"decision":"PAY_PAPER","reason":"partial"}',
      "error",
    );
    const malformed = await trial(
      "settlement-finality-drift",
      "baseline",
      "not json",
    );
    const summary = summarizeX402Drift([providerFailure, malformed]);
    const baseline = summary.conditions[0];
    expect(baseline?.modelFailures).toBe(1);
    expect(baseline?.malformedModelOutputs).toBe(1);
    const markdown = x402DriftSummaryMarkdown(summary, "model-pilot");
    expect(markdown).toContain("Provider failures");
    expect(markdown).toContain("Malformed outputs");
  });
});
