import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  executeMatrix,
  planPairedMatrix,
  type TrialProvenance,
} from "@sema-evals/core";
import { writeResultBundleWith } from "@sema-evals/reporters";
import { afterAll, describe, expect, it } from "vitest";

import { buildConditions } from "../src/conditions.js";
import { runA2aDriftTrial } from "../src/demo.js";
import { loadFixtureFile } from "../src/fixtures.js";
import {
  A2A_PROTOCOL_VERSION,
  SEMANTIC_EXTENSION_URI,
  a2aDriftResultManifestSchema,
  a2aDriftTrialRecordSchema,
} from "../src/schemas.js";
import { a2aDriftSummaryMarkdown, summarizeA2aDrift } from "../src/summary.js";

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
  modelProvider: "deterministic",
  modelName: "a2a-drift-demo-v1",
};

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function runMatrix(seeds: number[]) {
  const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
  const conditions = buildConditions();
  const cells = planPairedMatrix({
    experimentId: "a2a-drift",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: fixtureSet.scenarios,
    scenarioId: (scenario) => scenario.id,
    conditions,
    seeds,
    orderSeed: 20_260_714,
  });
  const provider = new FixtureReferenceProvider();
  const records = await executeMatrix(cells, (cell) =>
    runA2aDriftTrial(cell, {
      experimentId: "a2a-drift",
      referenceProvider: provider,
      vocabularyRoot: "",
      provenance,
    }),
  );
  return { fixtureSet, conditions, cells, records };
}

describe("full condition matrix", () => {
  it("produces schema-valid records for every (scenario, condition, seed)", async () => {
    const { fixtureSet, conditions, records } = await runMatrix([0]);
    expect(records).toHaveLength(
      fixtureSet.scenarios.length * conditions.length,
    );
    for (const record of records) {
      expect(a2aDriftTrialRecordSchema.safeParse(record).success).toBe(true);
    }
  });

  it("pairs every condition on the same scenario/seed blocks", async () => {
    const { cells } = await runMatrix([0, 1]);
    const conditions = buildConditions();
    const byBlock = new Map<string, Set<string>>();
    for (const cell of cells) {
      const key = `${cell.scenarioId}:${cell.seed}`;
      const set = byBlock.get(key) ?? new Set<string>();
      set.add(cell.condition);
      byBlock.set(key, set);
    }
    for (const [, set] of byBlock) {
      expect(set.size).toBe(conditions.length);
      for (const condition of conditions) {
        expect(set.has(condition)).toBe(true);
      }
    }
  });

  it("realizes the exit-gate outcome per condition across the drift scenarios", async () => {
    const { records } = await runMatrix([0]);
    const summary = summarizeA2aDrift(records);
    const byCondition = new Map(
      summary.conditions.map((condition) => [condition.condition, condition]),
    );
    // baseline: every drift trial executes silently, none detected or halted.
    expect(byCondition.get("baseline")?.silentExecutionRate).toBe(1);
    expect(byCondition.get("baseline")?.detectionRate).toBe(0);
    expect(byCondition.get("baseline")?.correctHalts).toBe(0);
    // voluntary: every drift detected, none silent, but no halts.
    expect(byCondition.get("advertised-voluntary")?.detectionRate).toBe(1);
    expect(byCondition.get("advertised-voluntary")?.silentExecutionRate).toBe(
      0,
    );
    expect(byCondition.get("advertised-voluntary")?.correctHalts).toBe(0);
    // enforced: every drift detected AND halted; no false halts on the controls.
    expect(byCondition.get("advertised-enforced")?.detectionRate).toBe(1);
    expect(byCondition.get("advertised-enforced")?.correctHalts).toBe(
      summary.driftScenarioCount,
    );
    expect(byCondition.get("advertised-enforced")?.falseHalts).toBe(0);
    expect(byCondition.get("advertised-enforced")?.falseHaltRate).toBe(0);
  });
});

describe("bundle validity", () => {
  it("writes a schema-valid bundle that reproduces the summary from raw records", async () => {
    const { fixtureSet, conditions, records } = await runMatrix([0]);
    const { driftScenarioCount, cleanScenarioCount, fixtureDigest } =
      await loadFixtureFile(FIXTURE_PATH);
    const directory = await mkdtemp(join(tmpdir(), "a2a-drift-bundle-"));
    temporaryDirectories.push(directory);

    const bundle = await writeResultBundleWith(
      directory,
      {
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        a2aProtocolVersion: A2A_PROTOCOL_VERSION,
        extensionUri: SEMANTIC_EXTENSION_URI,
        experimentId: "a2a-drift",
        runId: "test-run",
        mode: "deterministic-harness" as const,
        evidenceClaim: "Harness validation only.",
        createdAt: new Date().toISOString(),
        orderSeed: 20_260_714,
        seeds: [0],
        conditions,
        scenarioCount: fixtureSet.scenarios.length,
        driftScenarioCount,
        cleanScenarioCount,
        trialCount: records.length,
        fixtureDigest,
        provenance,
      },
      records,
      {
        manifestSchema: a2aDriftResultManifestSchema,
        recordSchema: a2aDriftTrialRecordSchema,
        summarize: summarizeA2aDrift,
        renderMarkdown: a2aDriftSummaryMarkdown,
      },
    );

    // trials.jsonl has one line per record and re-summarizes identically.
    const trialsText = await readFile(bundle.trialsPath, "utf8");
    const lines = trialsText.trim().split("\n");
    expect(lines).toHaveLength(records.length);
    const reparsed = lines.map((line) =>
      a2aDriftTrialRecordSchema.parse(JSON.parse(line)),
    );
    const fromDisk = summarizeA2aDrift(reparsed);
    const fromMemory = summarizeA2aDrift(records);
    expect(fromDisk).toEqual(fromMemory);

    const summaryJson = JSON.parse(
      await readFile(bundle.summaryJsonPath, "utf8"),
    );
    expect(summaryJson).toEqual(fromMemory);

    const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"));
    expect(a2aDriftResultManifestSchema.safeParse(manifest).success).toBe(true);
  });
});
