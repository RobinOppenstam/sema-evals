import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  executeMatrix,
  planPairedMatrix,
  type TrialProvenance,
} from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import { parseArgs, runWorkflowValueCli } from "../src/cli.js";
import { buildConditions } from "../src/conditions.js";
import { loadFixtureFile } from "../src/fixtures.js";
import { WORKFLOW_VALUE_PROTOCOL_VERSION } from "../src/schemas.js";
import { summarizeWorkflowValue } from "../src/summary.js";
import { runDeterministicWorkflowTrial } from "../src/trial.js";

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
  modelProvider: "deterministic",
  modelName: "workflow-value-scripted-executor-v1",
};

describe("workflow matrix, summary, and CLI", () => {
  it("pairs every task/seed across randomized conditions and reports eval primary", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const conditions = buildConditions();
    const cells = planPairedMatrix({
      experimentId: "workflow-value",
      protocolVersion: WORKFLOW_VALUE_PROTOCOL_VERSION,
      scenarios: fixtureSet.tasks,
      scenarioId: (task) => task.id,
      conditions,
      seeds: [0, 1],
      orderSeed: 20_260_716,
    });
    const records = await executeMatrix(cells, (cell) =>
      runDeterministicWorkflowTrial(cell, {
        experimentId: "workflow-value",
        datasetLabel: fixtureSet.dataset.label,
        referenceProvider: new FixtureReferenceProvider(),
        provenance,
      }),
    );
    expect(records).toHaveLength(
      fixtureSet.tasks.length * conditions.length * 2,
    );
    expect(records.map((record) => record.executionIndex)).toEqual(
      records.map((_, index) => index),
    );
    const summary = summarizeWorkflowValue(records);
    expect(
      summary.conditions.find((row) => row.condition === "task-only")
        ?.evalSuccessWithinBudgetRate,
    ).toBe(0);
    expect(
      summary.conditions.find((row) => row.condition === "equal-prose")
        ?.evalSuccessWithinBudgetRate,
    ).toBe(1);
    expect(
      summary.conditions.find((row) => row.condition === "content-addressed")
        ?.pairedEvalDifferenceFromTaskOnly,
    ).toBe(1);
  });

  it("rejects live model mode and writes a completed durable seed bundle", async () => {
    expect(() => parseArgs(["--mode", "model-pilot"])).toThrow(/not runnable/);
    const output = join(
      tmpdir(),
      `workflow-value-cli-${process.pid}-${Date.now()}-${Math.random()}`,
    );
    const directory = await runWorkflowValueCli([
      "--fixtures",
      FIXTURE_PATH,
      "--output",
      output,
    ]);
    const state = JSON.parse(
      await readFile(join(directory, "run-state.json"), "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    const partial = (
      await readFile(join(directory, "trials.partial.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    expect(state).toMatchObject({
      status: "completed",
      settledTrialCount: 15,
    });
    expect(manifest.datasetGate).toMatchObject({
      status: "seed-only",
      readyForModelPilot: false,
    });
    expect(manifest.scorer.fingerprint).toHaveLength(64);
    expect(manifest.protocolFingerprint).toHaveLength(64);
    expect(partial).toHaveLength(15);
  });
});
