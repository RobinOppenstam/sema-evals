import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  planPairedMatrix,
  type TrialProvenance,
} from "@sema-evals/core";
import { afterEach, describe, expect, it } from "vitest";

import { runSemaDiscoveryCli } from "../src/cli.js";
import { loadDiscoveryFixtures } from "../src/fixtures.js";
import {
  SEMA_DISCOVERY_PROTOCOL_VERSION,
  semaDiscoveryManifestSchema,
  semaDiscoveryTrialRecordSchema,
} from "../src/schemas.js";
import { runSemaDiscoveryTrial } from "../src/trial.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/catalog.yaml",
);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  directories.length = 0;
});

const provenance: TrialProvenance = {
  artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
  protocolVersion: SEMA_DISCOVERY_PROTOCOL_VERSION,
  fixtureDigest: "a".repeat(64),
  implementationCommit: "test",
  dependencyLockDigest: "b".repeat(64),
  promptDigest: "c".repeat(64),
  semaVersion: "not-connected",
  canonicalizationVersion: "fixture-stable-json-v1",
  vocabularyRoot: "d".repeat(64),
  semanticBackend: "fixture-sha256-stable-json-v1",
  modelProvider: "deterministic",
  modelName: "scripted-discovery-executor-v1",
};

describe("discovery trial matrix", () => {
  it("isolates preselection, repeated discovery, and session reuse", async () => {
    const { fixtureSet } = await loadDiscoveryFixtures(FIXTURE_PATH);
    const scenario = fixtureSet.scenarios[0];
    if (!scenario) {
      throw new Error("missing scenario");
    }
    const conditions = [
      "task-only",
      "preselected-prose",
      "preselected-addressed",
      "discovery",
      "discovery-reuse",
    ] as const;
    const cells = planPairedMatrix({
      experimentId: "sema-discovery",
      protocolVersion: SEMA_DISCOVERY_PROTOCOL_VERSION,
      scenarios: [scenario],
      scenarioId: (entry) => entry.id,
      conditions,
      seeds: [0],
      orderSeed: 1,
    });
    const records = await Promise.all(
      cells.map((cell) =>
        runSemaDiscoveryTrial(cell, {
          catalog: fixtureSet.catalog,
          referenceProvider: new FixtureReferenceProvider(),
          provenance,
        }),
      ),
    );
    const byCondition = new Map(
      records.map((record) => [record.condition, record]),
    );
    expect(byCondition.get("task-only")?.metrics.executionsPassed).toBe(0);
    expect(
      byCondition.get("preselected-prose")?.metrics.searchesPerformed,
    ).toBe(0);
    expect(
      byCondition.get("preselected-addressed")?.metrics.hydrationBytes,
    ).toBeGreaterThan(0);
    expect(byCondition.get("discovery")?.metrics.searchesPerformed).toBe(2);
    expect(byCondition.get("discovery")?.metrics.reuseHits).toBe(0);
    expect(byCondition.get("discovery")?.metrics.endToEndDiscoverySuccess).toBe(
      true,
    );
    expect(byCondition.get("discovery-reuse")?.metrics.searchesPerformed).toBe(
      1,
    );
    expect(byCondition.get("discovery-reuse")?.metrics.reuseHits).toBe(1);
    expect(byCondition.get("discovery-reuse")?.metrics.searchesAvoided).toBe(1);
    expect(
      byCondition.get("discovery-reuse")?.metrics.sessionResetAtStart,
    ).toBe(true);
    expect(
      byCondition.get("discovery-reuse")?.metrics.sessionClearedAtEnd,
    ).toBe(true);
  });

  it("writes a schema-valid durable bundle", async () => {
    const outputRoot = join(
      tmpdir(),
      `sema-discovery-${process.pid}-${Date.now()}`,
    );
    directories.push(outputRoot);
    const directory = await runSemaDiscoveryCli([
      "--output",
      outputRoot,
      "--seeds",
      "1",
    ]);
    const manifest = semaDiscoveryManifestSchema.parse(
      JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
    );
    expect(manifest.trialCount).toBe(5);
    expect(manifest.searchParameters.ordering).toBe("score-desc-handle-asc");
    const records = (await readFile(join(directory, "trials.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => semaDiscoveryTrialRecordSchema.parse(JSON.parse(line)));
    expect(records).toHaveLength(5);
    expect(records.every((record) => record.metrics.sessionClearedAtEnd)).toBe(
      true,
    );
    const state = JSON.parse(
      await readFile(join(directory, "run-state.json"), "utf8"),
    );
    expect(state).toMatchObject({
      status: "completed",
      settledTrialCount: 5,
    });
  });
});
