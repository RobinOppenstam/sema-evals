import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  executeMatrix,
  planPairedMatrix,
  type MatrixCell,
  type TrialProvenance,
} from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import { buildConditions } from "../src/conditions.js";
import { loadFixtureFile } from "../src/fixtures.js";
import {
  semaTaxTrialRecordSchema,
  type SemaTaxPattern,
  type SemaTaxScenario,
} from "../src/schemas.js";
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

async function runOne(
  scenario: SemaTaxScenario,
  patternsByHandle: Map<string, SemaTaxPattern>,
  condition: string,
) {
  return runSimulatedTaxTrial(cellFor(scenario, condition), {
    experimentId: "sema-tax",
    referenceProvider: new FixtureReferenceProvider(),
    patternsByHandle,
    provenance,
  });
}

describe("runSimulatedTaxTrial scoring curve", () => {
  it("gives the benefit side of the tax curve: score equals active-set coverage", async () => {
    const { scenario, patternsByHandle } = await load();
    // The settlement-desk items reference pool positions [0,1,3,5,7,10,13,15],
    // so coverage by pattern count is exactly: 0->0, 2->2, 4->3, 8->5, 12->6,
    // 16->8 of the 8 items.
    const expected: Record<string, number> = {
      "p0-baseline": 0,
      "p2-prose-cold": 2 / 8,
      "p4-prose-cold": 3 / 8,
      "p8-prose-cold": 5 / 8,
      "p12-prose-cold": 6 / 8,
      "p16-prose-cold": 1,
    };
    for (const [condition, score] of Object.entries(expected)) {
      const record = await runOne(scenario, patternsByHandle, condition);
      expect(record.metrics.score).toBeCloseTo(score, 10);
      expect(record.metrics.itemsTotal).toBe(8);
      expect(record.metrics.itemsCorrect).toBe(Math.round(score * 8));
    }
  });

  it("scores the baseline anchor at zero and marks no task success", async () => {
    const { scenario, patternsByHandle } = await load();
    const record = await runOne(scenario, patternsByHandle, "p0-baseline");
    expect(record.metrics.score).toBe(0);
    expect(record.metrics.taskSuccess).toBe(false);
    expect(record.metrics.activePatternCount).toBe(0);
    expect(record.metrics.hydrationBytes).toBe(0);
    expect(record.metrics.cachedInputTokensRead).toBe(0);
  });

  it("marks task success only when every item is covered", async () => {
    const { scenario, patternsByHandle } = await load();
    const full = await runOne(scenario, patternsByHandle, "p16-content-warm");
    expect(full.metrics.taskSuccess).toBe(true);
    expect(full.metrics.score).toBe(1);
  });
});

describe("runSimulatedTaxTrial cost channels", () => {
  it("splits fresh and cached input tokens by cache state without changing throughput", async () => {
    const { scenario, patternsByHandle } = await load();
    const cold = await runOne(scenario, patternsByHandle, "p8-prose-cold");
    const warm = await runOne(scenario, patternsByHandle, "p8-prose-warm");

    expect(cold.metrics.cachedInputTokensRead).toBe(0);
    expect(warm.metrics.cachedInputTokensRead).toBeGreaterThan(0);
    // Total token throughput is cache-agnostic; only where they are billed moves.
    expect(warm.metrics.inputTokens).toBe(cold.metrics.inputTokens);
    expect(warm.metrics.totalModelTokens).toBe(cold.metrics.totalModelTokens);
    // A warm cache reads its prefix at the cheaper rate, so it costs less.
    expect(warm.metrics.costUsd).not.toBeNull();
    expect(cold.metrics.costUsd).not.toBeNull();
    expect(warm.metrics.costUsd as number).toBeLessThan(
      cold.metrics.costUsd as number,
    );
    // Same scored quality regardless of cache.
    expect(warm.metrics.score).toBe(cold.metrics.score);
  });

  it("records wire and hydration bytes separately and totals context bytes", async () => {
    const { scenario, patternsByHandle } = await load();
    const prose = await runOne(scenario, patternsByHandle, "p8-prose-cold");
    const opaque = await runOne(scenario, patternsByHandle, "p8-opaque-cold");

    expect(prose.metrics.hydrationBytes).toBe(0);
    expect(opaque.metrics.hydrationBytes).toBeGreaterThan(0);
    expect(prose.metrics.wireBytes).toBeGreaterThan(opaque.metrics.wireBytes);
    expect(opaque.metrics.totalContextBytes).toBe(
      opaque.metrics.wireBytes + opaque.metrics.hydrationBytes,
    );
  });

  it("token cost grows with pattern count (the tax)", async () => {
    const { scenario, patternsByHandle } = await load();
    const counts = [2, 4, 8, 12, 16];
    let previous = 0;
    for (const count of counts) {
      const record = await runOne(
        scenario,
        patternsByHandle,
        `p${count}-prose-cold`,
      );
      expect(record.metrics.totalModelTokens).toBeGreaterThan(previous);
      previous = record.metrics.totalModelTokens;
    }
  });
});

describe("runSimulatedTaxTrial matrix", () => {
  it("runs the full condition matrix producing schema-valid records", async () => {
    const { fixtureSet, patternsByHandle } =
      await loadFixtureFile(FIXTURE_PATH);
    const conditions = buildConditions();
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
    const records = await executeMatrix(cells, (cell) =>
      runSimulatedTaxTrial(cell, {
        experimentId: "sema-tax",
        referenceProvider: provider,
        patternsByHandle,
        provenance,
      }),
    );

    expect(records).toHaveLength(
      fixtureSet.scenarios.length * conditions.length,
    );
    for (const record of records) {
      expect(semaTaxTrialRecordSchema.safeParse(record).success).toBe(true);
      expect(record.usage).toBeNull();
      expect(record.transcript).toBeNull();
    }
  });

  it("is deterministic across repetition seeds (zero within-condition variance)", async () => {
    const { scenario, patternsByHandle } = await load();
    const a = await runSimulatedTaxTrial(
      cellForSeed(scenario, "p8-content-cold", 0),
      {
        experimentId: "sema-tax",
        referenceProvider: new FixtureReferenceProvider(),
        patternsByHandle,
        provenance,
      },
    );
    const b = await runSimulatedTaxTrial(
      cellForSeed(scenario, "p8-content-cold", 1),
      {
        experimentId: "sema-tax",
        referenceProvider: new FixtureReferenceProvider(),
        patternsByHandle,
        provenance,
      },
    );
    expect(a.metrics.score).toBe(b.metrics.score);
    expect(a.metrics.totalModelTokens).toBe(b.metrics.totalModelTokens);
    expect(a.metrics.wireBytes).toBe(b.metrics.wireBytes);
  });
});

function cellForSeed(
  scenario: SemaTaxScenario,
  condition: string,
  seed: number,
): MatrixCell<SemaTaxScenario, string> {
  const [cell] = planPairedMatrix({
    experimentId: "sema-tax",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: [scenario],
    scenarioId: (value) => value.id,
    conditions: [condition],
    seeds: [seed],
    orderSeed: 1,
  });
  if (!cell) {
    throw new Error("Expected one matrix cell.");
  }
  return cell;
}
