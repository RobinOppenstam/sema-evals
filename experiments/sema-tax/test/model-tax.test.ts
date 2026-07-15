import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FixtureReferenceProvider,
  type ModelAgentAdapter,
  type ModelAgentResponse,
  type ModelCompletion,
  type ModelCompletionStatus,
  type ModelPromptInput,
  type Transcript,
  type UsageTelemetry,
} from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  planPairedMatrix,
  type MatrixCell,
  type TrialProvenance,
} from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import { loadFixtureFile } from "../src/fixtures.js";
import { runModelTaxTrial } from "../src/model-tax.js";
import {
  semaTaxTrialRecordSchema,
  type SemaTaxPattern,
  type SemaTaxScenario,
} from "../src/schemas.js";
import { evaluateItem } from "../src/scorer.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/worksheets.yaml",
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
  modelProvider: "anthropic",
  modelName: "claude-sonnet-5",
};

function usageOf(overrides: Partial<UsageTelemetry> = {}): UsageTelemetry {
  return {
    inputTokens: 120,
    cachedInputTokensRead: 0,
    cachedInputTokensWritten: 0,
    reasoningTokens: null,
    outputTokens: 40,
    attempts: 1,
    retries: 0,
    errors: [],
    latencyMs: 12,
    stopReason: "end_turn",
    costUsd: null,
    ...overrides,
  };
}

function transcriptOf(text: string): Transcript {
  return {
    entries: [
      {
        index: 0,
        attempt: 0,
        role: "system",
        content: [
          {
            type: "text",
            text: "Role: worksheet-solver",
            toolName: null,
            toolInput: null,
          },
        ],
        raw: null,
      },
      {
        index: 1,
        attempt: 0,
        role: "assistant",
        content: [{ type: "text", text, toolName: null, toolInput: null }],
        raw: null,
      },
    ],
  };
}

function fakeAdapter(
  text: string,
  usage: UsageTelemetry,
  status: ModelCompletionStatus = "completed",
): ModelAgentAdapter<ModelPromptInput, ModelCompletion> {
  return {
    descriptor: {
      id: "fake",
      provider: "fake",
      model: "fake-model",
      deterministic: false,
    },
    invoke: async (): Promise<ModelAgentResponse<ModelCompletion>> => ({
      output: { status, text, stopReason: usage.stopReason },
      elapsedMs: usage.latencyMs,
      raw: null,
      transcript: transcriptOf(text),
      usage,
    }),
  };
}

async function load(): Promise<{
  scenario: SemaTaxScenario;
  patternsByHandle: Map<string, SemaTaxPattern>;
}> {
  const { fixtureSet, patternsByHandle } = await loadFixtureFile(FIXTURE_PATH);
  const scenario = fixtureSet.scenarios.find((s) => s.id === "settlement-desk");
  if (!scenario) {
    throw new Error("Expected the settlement-desk scenario.");
  }
  return { scenario, patternsByHandle };
}

function cellFor(
  scenario: SemaTaxScenario,
  condition: string,
): MatrixCell<SemaTaxScenario, string> {
  const [cell] = planPairedMatrix({
    experimentId: "sema-tax",
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

function perfectAnswers(
  scenario: SemaTaxScenario,
  patternsByHandle: Map<string, SemaTaxPattern>,
): string {
  return scenario.items
    .map((item) => {
      const pattern = patternsByHandle.get(item.patternHandle);
      if (!pattern) {
        throw new Error(`Missing pattern ${item.patternHandle}.`);
      }
      return `ITEM ${item.id}: ${evaluateItem(pattern, item.value)}`;
    })
    .join("\n");
}

describe("runModelTaxTrial", () => {
  it("scores the model's answers and carries real usage into the metrics", async () => {
    const { scenario, patternsByHandle } = await load();
    const usage = usageOf({
      inputTokens: 300,
      cachedInputTokensRead: 90,
      outputTokens: 55,
      reasoningTokens: 12,
      costUsd: 0.002,
    });
    // A cold resolver arm: hydration bytes are charged harness-side, while the
    // token fields (including cached reads) come from the provider's usage.
    const record = await runModelTaxTrial(
      cellFor(scenario, "p8-content-cold"),
      {
        experimentId: "sema-tax",
        referenceProvider: new FixtureReferenceProvider(),
        patternsByHandle,
        provenance,
        adapter: fakeAdapter(perfectAnswers(scenario, patternsByHandle), usage),
      },
    );

    expect(record.metrics.taskSuccess).toBe(true);
    expect(record.metrics.score).toBe(1);
    // Token fields come from the provider's usage, not the harness estimate.
    expect(record.metrics.inputTokens).toBe(300);
    expect(record.metrics.cachedInputTokensRead).toBe(90);
    expect(record.metrics.outputTokens).toBe(55);
    expect(record.metrics.reasoningTokens).toBe(12);
    expect(record.metrics.totalModelTokens).toBe(355);
    expect(record.metrics.costUsd).toBe(0.002);
    // Byte channels are still measured harness-side.
    expect(record.metrics.hydrationBytes).toBeGreaterThan(0);
    expect(record.metrics.wireBytes).toBeGreaterThan(0);
    expect(record.usage).not.toBeNull();
    expect(record.transcript).not.toBeNull();
    expect(semaTaxTrialRecordSchema.safeParse(record).success).toBe(true);
  });

  it("preserves a failed model call as a zero-score failure with its transcript", async () => {
    const { scenario, patternsByHandle } = await load();
    const usage = usageOf({
      inputTokens: 0,
      outputTokens: 0,
      attempts: 5,
      retries: 4,
      errors: ["overloaded", "overloaded", "overloaded", "overloaded", "500"],
      stopReason: null,
    });
    const record = await runModelTaxTrial(cellFor(scenario, "p4-opaque-cold"), {
      experimentId: "sema-tax",
      referenceProvider: new FixtureReferenceProvider(),
      patternsByHandle,
      provenance,
      adapter: fakeAdapter("", usage, "error"),
    });

    expect(record.metrics.score).toBe(0);
    expect(record.metrics.taskSuccess).toBe(false);
    expect(record.metrics.itemsCorrect).toBe(0);
    expect(record.usage?.attempts).toBe(5);
    expect(record.transcript).not.toBeNull();
    expect(semaTaxTrialRecordSchema.safeParse(record).success).toBe(true);
  });

  it("grades a partial worksheet from the parsed answer lines", async () => {
    const { scenario, patternsByHandle } = await load();
    // Answer only the first four items correctly.
    const lines = scenario.items.slice(0, 4).map((item) => {
      const pattern = patternsByHandle.get(item.patternHandle);
      if (!pattern) {
        throw new Error("missing pattern");
      }
      return `ITEM ${item.id}: ${evaluateItem(pattern, item.value)}`;
    });
    const record = await runModelTaxTrial(cellFor(scenario, "p16-prose-cold"), {
      experimentId: "sema-tax",
      referenceProvider: new FixtureReferenceProvider(),
      patternsByHandle,
      provenance,
      adapter: fakeAdapter(lines.join("\n"), usageOf()),
    });

    expect(record.metrics.itemsCorrect).toBe(4);
    expect(record.metrics.itemsTotal).toBe(8);
    expect(record.metrics.score).toBe(0.5);
  });
});
