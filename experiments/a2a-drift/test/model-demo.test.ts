import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
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
  executeMatrix,
  planPairedMatrix,
  type MatrixCell,
  type TrialProvenance,
} from "@sema-evals/core";
import { writeResultBundleWith } from "@sema-evals/reporters";
import { afterAll, describe, expect, it } from "vitest";

import { A2A_DECISION_PARSER_VERSION } from "../src/decision.js";
import { loadFixtureFile } from "../src/fixtures.js";
import { SEMANTIC_MISMATCH_REASON } from "../src/middleware.js";
import { runModelA2aDriftTrial } from "../src/model-demo.js";
import {
  A2A_PROTOCOL_VERSION,
  SEMANTIC_EXTENSION_URI,
  a2aDriftResultManifestSchema,
  a2aDriftTrialRecordSchema,
  type A2aDriftCondition,
  type A2aDriftScenario,
} from "../src/schemas.js";
import { summarizeA2aDrift } from "../src/summary.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/scenarios.yaml",
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
  modelProvider: "fake",
  modelName: "scripted-worker",
};

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function usageOf(overrides: Partial<UsageTelemetry> = {}): UsageTelemetry {
  return {
    inputTokens: 80,
    cachedInputTokensRead: 0,
    cachedInputTokensWritten: 0,
    reasoningTokens: null,
    outputTokens: 30,
    attempts: 1,
    retries: 0,
    errors: [],
    latencyMs: 8,
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
            text: "Role: A2A worker agent",
            toolName: null,
            toolInput: null,
          },
        ],
        raw: null,
      },
      {
        index: 1,
        attempt: 0,
        role: "user",
        content: [
          { type: "text", text: "user", toolName: null, toolInput: null },
        ],
        raw: null,
      },
      {
        index: 2,
        attempt: 0,
        role: "assistant",
        content: [{ type: "text", text, toolName: null, toolInput: null }],
        raw: null,
      },
    ],
  };
}

function scriptedAdapter(
  text: string,
  usage: UsageTelemetry = usageOf(),
  status: ModelCompletionStatus = "completed",
): ModelAgentAdapter<ModelPromptInput, ModelCompletion> {
  return {
    descriptor: {
      id: "scripted-worker",
      provider: "fake",
      model: "scripted-worker",
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

async function scenarioById(id: string): Promise<A2aDriftScenario> {
  const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
  const scenario = fixtureSet.scenarios.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Expected scenario ${id}.`);
  }
  return scenario;
}

function cellFor(
  scenario: A2aDriftScenario,
  condition: A2aDriftCondition,
): MatrixCell<A2aDriftScenario, A2aDriftCondition> {
  const [cell] = planPairedMatrix({
    experimentId: "a2a-drift",
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

async function run(
  id: string,
  condition: A2aDriftCondition,
  decisionText: string,
) {
  const scenario = await scenarioById(id);
  return runModelA2aDriftTrial(cellFor(scenario, condition), {
    experimentId: "a2a-drift",
    referenceProvider: new FixtureReferenceProvider(),
    vocabularyRoot: "",
    provenance,
    adapter: scriptedAdapter(decisionText),
  });
}

describe("runModelA2aDriftTrial (scripted adapter)", () => {
  it("baseline drift: middleware cannot detect; model proceed ships silently", async () => {
    const record = await run(
      "settlement-drift",
      "baseline",
      "Work product.\nDECISION: proceed — completed with local definitions",
    );
    expect(record.metrics.driftInjected).toBe(true);
    expect(record.metrics.driftDetected).toBe(false);
    expect(record.metrics.silentExecution).toBe(true);
    expect(record.modelDecision).toBe("proceed");
    expect(record.decisionParserVersion).toBe(A2A_DECISION_PARSER_VERSION);
    expect(record.finalTaskState).toBe("completed");
    expect(record.metrics.halted).toBe(false);
    expect(record.metrics.taskSuccess).toBe(false);
    expect(record.usage?.attempts).toBe(1);
    expect(record.transcript?.entries.length).toBeGreaterThan(0);
    expect(a2aDriftTrialRecordSchema.parse(record)).toEqual(record);
  });

  it("advertised-voluntary drift: middleware detects; model halt acts on detection", async () => {
    const record = await run(
      "settlement-drift",
      "advertised-voluntary",
      "Mismatch in verification report.\nDECISION: halt — reference digest diverged",
    );
    expect(record.metrics.driftDetected).toBe(true);
    expect(record.metrics.silentExecution).toBe(false);
    expect(record.modelDecision).toBe("halt");
    expect(record.metrics.halted).toBe(true);
    expect(record.finalTaskState).toBe("failed");
    expect(record.metrics.failureReason).toBe("model-worker-halt");
    expect(record.metrics.taskSuccess).toBe(true);
    expect(record.metrics.correctHalt).toBe(true);
  });

  it("advertised-voluntary drift: model proceed still ships after detection", async () => {
    const record = await run(
      "settlement-drift",
      "advertised-voluntary",
      "Saw mismatch but continuing.\nDECISION: proceed — voluntary",
    );
    expect(record.metrics.driftDetected).toBe(true);
    expect(record.modelDecision).toBe("proceed");
    expect(record.metrics.halted).toBe(false);
    expect(record.finalTaskState).toBe("completed");
    expect(record.metrics.taskSuccess).toBe(false);
  });

  it("advertised-enforced drift: middleware refuses completed regardless of model proceed", async () => {
    const record = await run(
      "settlement-drift",
      "advertised-enforced",
      "I would proceed.\nDECISION: proceed — ignore mismatch",
    );
    expect(record.metrics.driftDetected).toBe(true);
    expect(record.modelDecision).toBe("proceed");
    expect(record.metrics.halted).toBe(true);
    expect(record.finalTaskState).toBe("failed");
    expect(record.metrics.failureReason).toBe(SEMANTIC_MISMATCH_REASON);
    expect(record.metrics.taskSuccess).toBe(true);
  });

  it("advertised-enforced no-drift: no false halt when model proceeds", async () => {
    const record = await run(
      "settlement-clean",
      "advertised-enforced",
      "Clean.\nDECISION: proceed — all matched",
    );
    expect(record.metrics.driftInjected).toBe(false);
    expect(record.metrics.driftDetected).toBe(false);
    expect(record.metrics.falseHalt).toBe(false);
    expect(record.finalTaskState).toBe("completed");
    expect(record.metrics.taskSuccess).toBe(true);
  });

  it("preserves malformed DECISION as a failure without dropping the transcript", async () => {
    const record = await run(
      "settlement-drift",
      "advertised-voluntary",
      "I am unsure what to do.",
    );
    expect(record.modelDecision).toBe("malformed");
    expect(record.metrics.taskSuccess).toBe(false);
    expect(record.transcript).not.toBeNull();
    expect(record.usage).not.toBeNull();
  });
});

describe("model-pilot record schema and bundle", () => {
  it("round-trips an extended trial record through the schema", async () => {
    const record = await run(
      "settlement-drift",
      "advertised-voluntary",
      "Done.\nDECISION: halt — mismatch",
    );
    const parsed = a2aDriftTrialRecordSchema.parse(
      JSON.parse(JSON.stringify(record)),
    );
    expect(parsed.modelDecision).toBe("halt");
    expect(parsed.decisionParserVersion).toBe(A2A_DECISION_PARSER_VERSION);
    expect(parsed.usage?.inputTokens).toBe(80);
    expect(parsed.transcript?.entries[0]?.role).toBe("system");
  });

  it("writes a model-pilot bundle with the extended manifest", async () => {
    const {
      fixtureSet,
      fixtureDigest,
      driftScenarioCount,
      cleanScenarioCount,
    } = await loadFixtureFile(FIXTURE_PATH);
    const scenario = fixtureSet.scenarios.find(
      (s) => s.id === "settlement-drift",
    );
    if (!scenario) {
      throw new Error("Expected settlement-drift.");
    }
    const conditions: A2aDriftCondition[] = [
      "baseline",
      "advertised-voluntary",
      "advertised-enforced",
    ];
    const cells = planPairedMatrix({
      experimentId: "a2a-drift",
      protocolVersion: PROTOCOL_VERSION,
      scenarios: [scenario],
      scenarioId: (value) => value.id,
      conditions,
      seeds: [0],
      orderSeed: 20_260_714,
    });
    const provider = new FixtureReferenceProvider();
    const adapter = scriptedAdapter("Work.\nDECISION: halt — mismatch");
    const records = await executeMatrix(cells, (cell) =>
      runModelA2aDriftTrial(cell, {
        experimentId: "a2a-drift",
        referenceProvider: provider,
        vocabularyRoot: "",
        provenance: { ...provenance, fixtureDigest },
        adapter,
      }),
    );

    const directory = await mkdtemp(join(tmpdir(), "a2a-model-pilot-"));
    temporaryDirectories.push(directory);
    const createdAt = new Date("2026-07-16T12:00:00.000Z");
    const runId = "20260716T120000000Z-order-20260714";
    const bundle = await writeResultBundleWith(
      directory,
      {
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        a2aProtocolVersion: A2A_PROTOCOL_VERSION,
        extensionUri: SEMANTIC_EXTENSION_URI,
        experimentId: "a2a-drift",
        runId,
        mode: "model-pilot" as const,
        evidenceClaim:
          "Exploratory model pilot. Not preregistered, not confirmatory evidence.",
        createdAt: createdAt.toISOString(),
        orderSeed: 20_260_714,
        seeds: [0],
        conditions,
        scenarioCount: 1,
        driftScenarioCount,
        cleanScenarioCount,
        trialCount: records.length,
        fixtureDigest,
        provenance: { ...provenance, fixtureDigest },
      },
      records,
      {
        manifestSchema: a2aDriftResultManifestSchema,
        recordSchema: a2aDriftTrialRecordSchema,
        summarize: summarizeA2aDrift,
        renderMarkdown: () => "# model-pilot\n",
      },
    );

    const manifestRaw = await readFile(bundle.manifestPath, "utf8");
    const manifest = a2aDriftResultManifestSchema.parse(
      JSON.parse(manifestRaw),
    );
    expect(manifest.mode).toBe("model-pilot");
    expect(manifest.trialCount).toBe(3);
    expect(manifest.evidenceClaim).toMatch(/Exploratory model pilot/);

    const trialsText = await readFile(bundle.trialsPath, "utf8");
    const rawRecords = trialsText
      .trim()
      .split("\n")
      .map((line) => a2aDriftTrialRecordSchema.parse(JSON.parse(line)));
    expect(rawRecords).toHaveLength(3);
    for (const record of rawRecords) {
      expect(record.decisionParserVersion).toBe(A2A_DECISION_PARSER_VERSION);
      expect(record.usage).not.toBeNull();
      expect(record.transcript).not.toBeNull();
    }
  });
});
