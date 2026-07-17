import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FixtureReferenceProvider,
  type ModelAgentAdapter,
  type ModelAgentResponse,
  type ModelCompletion,
  type ModelCompletionStatus,
  type ModelPromptInput,
  type UsageTelemetry,
} from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  planPairedMatrix,
  type TrialProvenance,
} from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import { buildConditions } from "../src/conditions.js";
import { loadFixtureFile } from "../src/fixtures.js";
import {
  WORKFLOW_TOTAL_TOKEN_BUDGET,
  WORKFLOW_VALUE_PROTOCOL_VERSION,
  workflowValueTrialRecordSchema,
  type WorkflowTask,
  type WorkflowValueCondition,
} from "../src/schemas.js";
import {
  runDeterministicWorkflowTrial,
  runModelWorkflowTrial,
} from "../src/trial.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/seed-tasks.yaml",
);
const provenance: TrialProvenance = {
  artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
  protocolVersion: WORKFLOW_VALUE_PROTOCOL_VERSION,
  fixtureDigest: "a".repeat(64),
  implementationCommit: "test",
  dependencyLockDigest: "b".repeat(64),
  promptDigest: "c".repeat(64),
  semaVersion: "not-connected",
  canonicalizationVersion: "fixture-stable-json-v1",
  vocabularyRoot: "",
  semanticBackend: "fixture-sha256-stable-json-v1",
  modelProvider: "fake",
  modelName: "fake-workflow-model",
};

function cellFor(task: WorkflowTask, condition: WorkflowValueCondition) {
  return planPairedMatrix({
    experimentId: "workflow-value",
    protocolVersion: WORKFLOW_VALUE_PROTOCOL_VERSION,
    scenarios: [task],
    scenarioId: (value) => value.id,
    conditions: [condition],
    seeds: [0],
    orderSeed: 1,
  })[0]!;
}

function usage(overrides: Partial<UsageTelemetry>): UsageTelemetry {
  return {
    inputTokens: 100,
    cachedInputTokensRead: 0,
    cachedInputTokensWritten: 0,
    reasoningTokens: null,
    outputTokens: 50,
    attempts: 1,
    retries: 0,
    errors: [],
    latencyMs: 5,
    stopReason: "end_turn",
    costUsd: null,
    ...overrides,
  };
}

function sequenceAdapter(
  responses: readonly {
    status: ModelCompletionStatus;
    text: string;
    usage: UsageTelemetry;
  }[],
): ModelAgentAdapter<ModelPromptInput, ModelCompletion> {
  let index = 0;
  return {
    descriptor: {
      id: "fake",
      provider: "fake",
      model: "fake",
      deterministic: false,
    },
    invoke: async (): Promise<ModelAgentResponse<ModelCompletion>> => {
      const current = responses[index++];
      if (!current) {
        throw new Error("Fake response sequence exhausted.");
      }
      return {
        output: {
          status: current.status,
          text: current.text,
          stopReason: current.usage.stopReason,
        },
        usage: current.usage,
        transcript: {
          entries: [
            {
              index: 0,
              attempt: 0,
              role: current.status === "error" ? "error" : "assistant",
              content: [
                {
                  type: "text",
                  text: current.text,
                  toolName: null,
                  toolInput: null,
                },
              ],
              raw: null,
            },
          ],
        },
        elapsedMs: current.usage.latencyMs,
        raw: null,
      };
    },
  };
}

describe("workflow trial execution", () => {
  it("exercises every deterministic condition under one fixed budget", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const task = fixtureSet.tasks.find((entry) => entry.split === "eval")!;
    const records = await Promise.all(
      buildConditions().map((condition) =>
        runDeterministicWorkflowTrial(cellFor(task, condition), {
          experimentId: "workflow-value",
          datasetLabel: "synthetic-seed-fixtures",
          referenceProvider: new FixtureReferenceProvider(),
          provenance,
        }),
      ),
    );
    const byCondition = new Map(
      records.map((record) => [record.condition, record]),
    );
    expect(byCondition.get("task-only")!.metrics.successWithinBudget).toBe(
      false,
    );
    for (const condition of buildConditions().slice(1)) {
      expect(byCondition.get(condition)!.metrics.successWithinBudget).toBe(
        true,
      );
      expect(byCondition.get(condition)!.metrics.tokenBudget).toBe(
        WORKFLOW_TOTAL_TOKEN_BUDGET,
      );
    }
    expect(
      byCondition.get("content-addressed-repair")!.metrics.repairApplied,
    ).toBe(true);
  });

  it("records fake multi-attempt rework and tokens to first passing solution", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const task = fixtureSet.tasks[1]!;
    const first = usage({
      inputTokens: 200,
      outputTokens: 20,
      retries: 1,
      attempts: 2,
      errors: ["retry"],
      latencyMs: 7,
    });
    const second = usage({
      inputTokens: 240,
      outputTokens: 60,
      cachedInputTokensRead: 50,
      reasoningTokens: 10,
      latencyMs: 9,
    });
    const record = await runModelWorkflowTrial(
      cellFor(task, "content-addressed-repair"),
      {
        experimentId: "workflow-value",
        datasetLabel: "synthetic-seed-fixtures",
        referenceProvider: new FixtureReferenceProvider(),
        provenance,
        adapter: sequenceAdapter([
          { status: "completed", text: "{bad json", usage: first },
          {
            status: "completed",
            text: JSON.stringify(task.workflow.output),
            usage: second,
          },
        ]),
      },
    );
    expect(record.metrics).toMatchObject({
      successWithinBudget: true,
      editTestCycles: 2,
      failedEditTestCycles: 1,
      reworkCycles: 1,
      regressions: 0,
      tokensToFirstPassingSolution: 520,
      totalModelTokens: 520,
      retries: 1,
      providerErrors: 1,
      modelLatencyMs: 16,
    });
    expect(record.usage?.cachedInputTokensRead).toBe(50);
    expect(record.transcript?.entries).toHaveLength(2);
    expect(workflowValueTrialRecordSchema.parse(record)).toEqual(record);
  });

  it("preserves a passing output that exceeded budget as a primary failure", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const task = fixtureSet.tasks[2]!;
    const record = await runModelWorkflowTrial(
      cellFor(task, "content-addressed"),
      {
        experimentId: "workflow-value",
        datasetLabel: "synthetic-seed-fixtures",
        referenceProvider: new FixtureReferenceProvider(),
        provenance,
        adapter: sequenceAdapter([
          {
            status: "completed",
            text: JSON.stringify(task.workflow.output),
            usage: usage({ inputTokens: 1900, outputTokens: 200 }),
          },
        ]),
      },
    );
    expect(record.metrics.validationPassed).toBe(true);
    expect(record.metrics.withinTokenBudget).toBe(false);
    expect(record.metrics.successWithinBudget).toBe(false);
    expect(record.metrics.tokensToFirstPassingSolution).toBe(2100);
  });

  it("does not launch another call when remaining budget is below the reserve", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const task = fixtureSet.tasks[1]!;
    const record = await runModelWorkflowTrial(
      cellFor(task, "content-addressed"),
      {
        experimentId: "workflow-value",
        datasetLabel: "synthetic-seed-fixtures",
        referenceProvider: new FixtureReferenceProvider(),
        provenance,
        adapter: sequenceAdapter([
          {
            status: "completed",
            text: "{bad json",
            usage: usage({ inputTokens: 1600, outputTokens: 100 }),
          },
          {
            status: "completed",
            text: JSON.stringify(task.workflow.output),
            usage: usage({ inputTokens: 100, outputTokens: 50 }),
          },
        ]),
      },
    );
    expect(record.metrics.editTestCycles).toBe(1);
    expect(record.metrics.failedEditTestCycles).toBe(1);
    expect(record.metrics.reworkCycles).toBe(0);
  });

  it("fails closed on repository-workspace tasks without a tool runner", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const task: WorkflowTask = {
      ...fixtureSet.tasks[0]!,
      contract: {
        kind: "repository-workspace",
        repositoryFixture: "fixtures/repo.tar.zst",
        setupCommand: ["pnpm", "install"],
        validatorCommand: ["pnpm", "test"],
        allowedPaths: ["src/", "test/"],
      },
    };
    await expect(
      runDeterministicWorkflowTrial(cellFor(task, "task-only"), {
        experimentId: "workflow-value",
        datasetLabel: "external",
        referenceProvider: new FixtureReferenceProvider(),
        provenance,
      }),
    ).rejects.toThrow(/AgentWorkflowRunner/);
  });
});
