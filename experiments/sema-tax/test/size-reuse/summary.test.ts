import { dirname, resolve } from "node:path";
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

import { buildSizeReuseConditions } from "../../src/size-reuse/conditions.js";
import { runSimulatedSizeReuseTrial } from "../../src/size-reuse/executor.js";
import { loadSizeReuseFixtureFile } from "../../src/size-reuse/fixtures.js";
import {
  sizeReuseSummaryMarkdown,
  summarizeSizeReuse,
} from "../../src/size-reuse/summary.js";
import type { SemaTaxSizeReuseTrialRecord } from "../../src/size-reuse/schemas.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "../../fixtures/worksheets-size-reuse.yaml");

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

async function runMatrix(): Promise<SemaTaxSizeReuseTrialRecord[]> {
  const { fixtureSet, patternsByHandle } =
    await loadSizeReuseFixtureFile(FIXTURE_PATH);
  const conditions = buildSizeReuseConditions();
  const cells = planPairedMatrix({
    experimentId: "sema-tax",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: fixtureSet.scenarios,
    scenarioId: (scenario) => scenario.id,
    conditions,
    seeds: [0],
    orderSeed: 20_260_714,
  });
  const provider = new FixtureReferenceProvider();
  return executeMatrix(cells, (cell) =>
    runSimulatedSizeReuseTrial(cell, {
      experimentId: "sema-tax",
      referenceProvider: provider,
      patternsByHandle,
      provenance,
    }),
  );
}

describe("summarizeSizeReuse", () => {
  it("reports one row per condition, canonically ordered, with both endpoints", async () => {
    const records = await runMatrix();
    const summary = summarizeSizeReuse(records);
    expect(summary.trialCount).toBe(records.length);
    expect(summary.conditions).toHaveLength(27);
    expect(summary.conditions[0]?.condition).toBe("p8-small-r1-prose-cold");

    // Recompute the two primary endpoints for one condition from its records.
    const target = "p8-medium-r3-content-cold";
    const trials = records.filter((record) => record.condition === target);
    const summedScore = trials.reduce((t, r) => t + r.metrics.score, 0);
    const summedTokens = trials.reduce(
      (t, r) => t + r.metrics.totalModelTokens,
      0,
    );
    const summedBytes = trials.reduce(
      (t, r) => t + r.metrics.totalSemanticBytes,
      0,
    );
    const row = summary.conditions.find((c) => c.condition === target)!;
    expect(row.scorePerKToken).toBeCloseTo(
      (summedScore / summedTokens) * 1000,
      8,
    );
    expect(row.scorePerKSemanticByte).toBeCloseTo(
      (summedScore / summedBytes) * 1000,
      8,
    );
    expect(row.modelMessages).toBe(0);
    expect(row.modelFailureMessages).toBe(0);
    expect(row.meanCachedInputTokensRead).toBe(0);
  });

  it("computes a crossover surface where content overtakes prose as size×R grows", async () => {
    const records = await runMatrix();
    const { crossings } = summarizeSizeReuse(records);
    expect(crossings).toHaveLength(9); // 3 sizes x 3 reuse factors
    const at = (size: string, reuse: number) =>
      crossings.find((c) => c.size === size && c.reuse === reuse)!;

    // Published worst case for references: small definitions used once — prose wins.
    expect(at("small", 1).contentBeatsProseBytes).toBe(false);
    // Large definitions reused nine times: content wins on both denominators.
    expect(at("large", 9).contentBeatsProseBytes).toBe(true);
    expect(at("large", 9).contentBeatsProseTokens).toBe(true);
    // The crossover is a genuine surface: at least one cell flips each way.
    expect(crossings.some((c) => c.contentBeatsProseBytes)).toBe(true);
    expect(crossings.some((c) => !c.contentBeatsProseBytes)).toBe(true);
  });

  it("renders a markdown table with the arm caveat and the crossover surface", async () => {
    const records = await runMatrix();
    const markdown = sizeReuseSummaryMarkdown(summarizeSizeReuse(records));
    expect(markdown).toContain("size/reuse arm summary");
    expect(markdown).toContain("ADR 0013");
    expect(markdown).toContain("ADR 0011");
    expect(markdown).toContain("Crossover surface");
    expect(markdown).toContain("Total semantic B");
    expect(markdown).toContain("Score / 1k B");
    expect(markdown).toContain("p8-small-r1-prose-cold");
  });

  it("renders model-pilot caveats and separated provider token channels", async () => {
    const records = await runMatrix();
    const markdown = sizeReuseSummaryMarkdown(
      summarizeSizeReuse(records),
      "model-pilot",
    );
    expect(markdown).toContain("Exploratory model-run results");
    expect(markdown).toContain("Cached read tok");
    expect(markdown).toContain("Reasoning tok");
    expect(markdown).toContain("Failed calls");
    expect(markdown).not.toContain("Harness validation only");
  });
});
