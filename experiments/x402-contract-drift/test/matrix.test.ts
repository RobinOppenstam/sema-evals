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
import { runX402DriftTrial } from "../src/demo.js";
import { loadFixtureFile } from "../src/fixtures.js";
import {
  SEMANTIC_EXTENSION_URI,
  X402_PROTOCOL_VERSION,
  x402DriftResultManifestSchema,
  x402DriftTrialRecordSchema,
} from "../src/schemas.js";
import {
  summarizeX402Drift,
  x402DriftSummaryMarkdown,
} from "../src/summary.js";

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
  modelName: "x402-contract-drift-demo-v2",
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
    experimentId: "x402-contract-drift",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: fixtureSet.scenarios,
    scenarioId: (scenario) => scenario.id,
    conditions,
    seeds,
    orderSeed: 20_260_716,
  });
  const provider = new FixtureReferenceProvider();
  const records = await executeMatrix(cells, (cell) =>
    runX402DriftTrial(cell, {
      experimentId: "x402-contract-drift",
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
      expect(x402DriftTrialRecordSchema.safeParse(record).success).toBe(true);
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
    const summary = summarizeX402Drift(records);
    const byCondition = new Map(
      summary.conditions.map((condition) => [condition.condition, condition]),
    );
    expect(byCondition.get("baseline")?.silentPaymentRate).toBe(1);
    expect(byCondition.get("baseline")?.detectionRate).toBe(0);
    expect(byCondition.get("baseline")?.correctHalts).toBe(0);
    expect(byCondition.get("advertised-voluntary")?.detectionRate).toBe(1);
    expect(byCondition.get("advertised-voluntary")?.silentPaymentRate).toBe(0);
    expect(byCondition.get("advertised-voluntary")?.correctHalts).toBe(0);
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
    const directory = await mkdtemp(join(tmpdir(), "x402-drift-bundle-"));
    temporaryDirectories.push(directory);

    const bundle = await writeResultBundleWith(
      directory,
      {
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        x402ProtocolVersion: X402_PROTOCOL_VERSION,
        extensionUri: SEMANTIC_EXTENSION_URI,
        experimentId: "x402-contract-drift",
        runId: "test-run",
        mode: "deterministic-harness" as const,
        evidenceClaim: "Harness validation only.",
        createdAt: new Date().toISOString(),
        orderSeed: 20_260_716,
        seeds: [0],
        conditions,
        scenarioCount: fixtureSet.scenarios.length,
        driftScenarioCount,
        cleanScenarioCount,
        trialCount: records.length,
        fixtureDigest,
        scorer: {
          version: "test-scorer",
          fingerprint: "d".repeat(64),
        },
        protocolFingerprint: "e".repeat(64),
        runConfiguration: {
          mode: "deterministic-harness",
          repetitionCount: 1,
        },
        provenance,
      },
      records,
      {
        manifestSchema: x402DriftResultManifestSchema,
        recordSchema: x402DriftTrialRecordSchema,
        summarize: summarizeX402Drift,
        renderMarkdown: x402DriftSummaryMarkdown,
      },
    );

    const trialsText = await readFile(bundle.trialsPath, "utf8");
    const lines = trialsText.trim().split("\n");
    expect(lines).toHaveLength(records.length);
    const reparsed = lines.map((line) =>
      x402DriftTrialRecordSchema.parse(JSON.parse(line)),
    );
    const fromDisk = summarizeX402Drift(reparsed);
    const fromMemory = summarizeX402Drift(records);
    expect(fromDisk).toEqual(fromMemory);

    const summaryJson = JSON.parse(
      await readFile(bundle.summaryJsonPath, "utf8"),
    );
    expect(summaryJson).toEqual(fromMemory);

    const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"));
    expect(x402DriftResultManifestSchema.safeParse(manifest).success).toBe(
      true,
    );
  });
});
