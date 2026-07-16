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
import { runForecastingTrial } from "../src/demo.js";
import { loadFixtureFile } from "../src/fixtures.js";
import { buildLeakageAuditDocument } from "../src/leakage.js";
import {
  forecastingResultManifestSchema,
  forecastingTrialRecordSchema,
  leakageAuditDocumentSchema,
} from "../src/schemas.js";
import {
  forecastingSummaryMarkdown,
  recomputeTrialBriers,
  summarizeForecasting,
} from "../src/summary.js";
import { writeFile } from "node:fs/promises";

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
  modelName: "forecasting-council-demo-v1",
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
    experimentId: "forecasting",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: fixtureSet.scenarios,
    scenarioId: (scenario) => scenario.id,
    conditions,
    seeds,
    orderSeed: 20_260_716,
  });
  const provider = new FixtureReferenceProvider();
  const records = await executeMatrix(cells, (cell) =>
    runForecastingTrial(cell, {
      experimentId: "forecasting",
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
      expect(forecastingTrialRecordSchema.safeParse(record).success).toBe(true);
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
    const { records, fixtureSet } = await runMatrix([0]);
    const summary = summarizeForecasting(records, fixtureSet.scenarios);
    const byCondition = new Map(
      summary.conditions.map((condition) => [condition.condition, condition]),
    );
    expect(byCondition.get("baseline")?.corruptedAggregationRate).toBe(1);
    expect(byCondition.get("baseline")?.detectionRate).toBe(0);
    expect(byCondition.get("addressed-voluntary")?.detectionRate).toBe(1);
    expect(
      byCondition.get("addressed-voluntary")?.corruptedAggregationRate,
    ).toBe(0);
    expect(byCondition.get("addressed-voluntary")?.correctExclusions).toBe(0);
    expect(byCondition.get("addressed-enforced")?.detectionRate).toBe(1);
    expect(byCondition.get("addressed-enforced")?.correctExclusions).toBe(
      summary.driftScenarioCount,
    );
    expect(byCondition.get("addressed-enforced")?.falseExclusions).toBe(0);
    expect(byCondition.get("addressed-enforced")?.falseExclusionRate).toBe(0);
    expect(summary.leakageAuditPassed).toBe(true);
  });

  it("never false-excludes on no-drift controls under any condition", async () => {
    const { records } = await runMatrix([0]);
    const clean = records.filter((record) => !record.driftInjected);
    expect(clean.length).toBeGreaterThan(0);
    for (const record of clean) {
      expect(record.metrics.falseExclusion).toBe(false);
      expect(record.metrics.forecastsExcluded).toBe(0);
    }
  });

  it("recomputes every trial's Brier values from raw records", async () => {
    const { records } = await runMatrix([0]);
    for (const trial of records) {
      const recomputed = recomputeTrialBriers(trial);
      expect(recomputed.brierAggregate).toBe(trial.metrics.brierAggregate);
      expect(recomputed.brierMarketPrior).toBe(trial.metrics.brierMarketPrior);
      expect(recomputed.brierIndependentAverage).toBe(
        trial.metrics.brierIndependentAverage,
      );
    }
  });
});

describe("bundle validity", () => {
  it("writes a schema-valid bundle with leakage-audit.json that reproduces the summary", async () => {
    const { fixtureSet, conditions, records } = await runMatrix([0]);
    const { driftScenarioCount, cleanScenarioCount, fixtureDigest } =
      await loadFixtureFile(FIXTURE_PATH);
    const directory = await mkdtemp(join(tmpdir(), "forecasting-bundle-"));
    temporaryDirectories.push(directory);

    const summary = summarizeForecasting(records, fixtureSet.scenarios);
    const bundle = await writeResultBundleWith(
      directory,
      {
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        experimentId: "forecasting",
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
        leakageAuditPassed: summary.leakageAuditPassed,
        provenance,
      },
      records,
      {
        manifestSchema: forecastingResultManifestSchema,
        recordSchema: forecastingTrialRecordSchema,
        summarize: (trialRecords) =>
          summarizeForecasting(trialRecords, fixtureSet.scenarios),
        renderMarkdown: forecastingSummaryMarkdown,
      },
    );

    const leakagePath = join(bundle.directory, "leakage-audit.json");
    await writeFile(
      leakagePath,
      `${JSON.stringify(buildLeakageAuditDocument(fixtureSet.scenarios), null, 2)}\n`,
      "utf8",
    );
    const leakage = leakageAuditDocumentSchema.parse(
      JSON.parse(await readFile(leakagePath, "utf8")),
    );
    expect(leakage.entries).toHaveLength(fixtureSet.scenarios.length);

    const trialsText = await readFile(bundle.trialsPath, "utf8");
    const lines = trialsText.trim().split("\n");
    expect(lines).toHaveLength(records.length);
    const reparsed = lines.map((line) =>
      forecastingTrialRecordSchema.parse(JSON.parse(line)),
    );
    const fromDisk = summarizeForecasting(reparsed, fixtureSet.scenarios);
    const fromMemory = summarizeForecasting(records, fixtureSet.scenarios);
    expect(fromDisk).toEqual(fromMemory);

    const summaryJson = JSON.parse(
      await readFile(bundle.summaryJsonPath, "utf8"),
    );
    expect(summaryJson).toEqual(fromMemory);

    const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"));
    expect(forecastingResultManifestSchema.safeParse(manifest).success).toBe(
      true,
    );
    expect(manifest.leakageAuditPassed).toBe(true);
  });
});
