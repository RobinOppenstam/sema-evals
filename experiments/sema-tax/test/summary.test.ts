import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  executeMatrix,
  planPairedMatrix,
  type TrialProvenance,
} from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import { buildConditions } from "../src/conditions.js";
import { loadFixtureFile } from "../src/fixtures.js";
import { semaTaxSummaryMarkdown, summarizeSemaTax } from "../src/summary.js";
import { runSimulatedTaxTrial } from "../src/tax.js";

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
  modelProvider: "deterministic",
  modelName: "sema-tax-simulator-v1",
};

async function runMatrix() {
  const { fixtureSet, patternsByHandle } = await loadFixtureFile(FIXTURE_PATH);
  const conditions = buildConditions();
  const cells = planPairedMatrix({
    experimentId: "sema-tax",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: fixtureSet.scenarios,
    scenarioId: (scenario) => scenario.id,
    conditions,
    seeds: [0, 1],
    orderSeed: 20_260_714,
  });
  const provider = new FixtureReferenceProvider();
  return executeMatrix(cells, (cell) =>
    runSimulatedTaxTrial(cell, {
      experimentId: "sema-tax",
      referenceProvider: provider,
      patternsByHandle,
      provenance,
    }),
  );
}

describe("summarizeSemaTax", () => {
  it("reports one row per observed condition with the primary endpoint", async () => {
    const records = await runMatrix();
    const summary = summarizeSemaTax(records);

    expect(summary.trialCount).toBe(records.length);
    expect(summary.conditions.length).toBe(buildConditions().length);
    // Rows follow the canonical condition ordering (baseline first).
    expect(summary.conditions[0]?.condition).toBe("p0-baseline");

    for (const condition of summary.conditions) {
      // Deterministic executor: identical across repetition seeds, so zero
      // within-condition variance.
      expect(condition.scoreVariance).toBe(0);
      expect(condition.trials).toBeGreaterThan(0);
      // The deterministic executor is fully compliant, so every condition's mean
      // answered-rate is 1 (format compliance is decoupled from correctness).
      expect(condition.meanAnsweredRate).toBe(1);
      // The primary endpoint: graded score per 1000 billable model tokens.
      const expected =
        condition.meanTotalModelTokens === 0
          ? 0
          : (condition.meanScore / condition.meanTotalModelTokens) * 1000;
      expect(condition.scorePerKToken).toBeCloseTo(expected, 6);
    }
  });

  it("exposes both axes of the tax curve: score and token cost both rise with count", async () => {
    const records = await runMatrix();
    const summary = summarizeSemaTax(records);
    const byId = new Map(summary.conditions.map((c) => [c.condition, c]));
    const counts = [2, 4, 8, 12, 16];

    let previousScore = 0;
    let previousTokens = 0;
    for (const count of counts) {
      const row = byId.get(`p${count}-prose-cold`);
      expect(row).toBeDefined();
      const cell = row as NonNullable<typeof row>;
      // Benefit is non-decreasing; cost strictly increases. Whether score per
      // token peaks in the interior is an empirical question for the model
      // pilot, not a property the scripted harness can assert.
      expect(cell.meanScore).toBeGreaterThanOrEqual(previousScore);
      expect(cell.meanTotalModelTokens).toBeGreaterThan(previousTokens);
      expect(cell.scorePerKToken).toBeGreaterThanOrEqual(0);
      previousScore = cell.meanScore;
      previousTokens = cell.meanTotalModelTokens;
    }
  });

  it("renders a markdown table headed by the tax-curve caveat", async () => {
    const records = await runMatrix();
    const markdown = semaTaxSummaryMarkdown(summarizeSemaTax(records));
    expect(markdown).toContain("# Sema tax curve summary");
    expect(markdown).toContain("Harness validation only");
    expect(markdown).toContain("Score / 1k tok");
    expect(markdown).toContain("Answered rate");
    // The observational-cache caveat must be present in the preamble.
    expect(markdown).toContain("OBSERVATIONAL");
    expect(markdown).toContain("ADR 0011");
    expect(markdown).toContain("p0-baseline");
  });
});
