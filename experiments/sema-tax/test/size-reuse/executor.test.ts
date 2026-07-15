import { dirname, resolve } from "node:path";
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

import { buildSizeReuseConditions } from "../../src/size-reuse/conditions.js";
import { runSimulatedSizeReuseTrial } from "../../src/size-reuse/executor.js";
import { loadSizeReuseFixtureFile } from "../../src/size-reuse/fixtures.js";
import {
  semaTaxSizeReuseTrialRecordSchema,
  type SemaTaxSizedPattern,
} from "../../src/size-reuse/schemas.js";
import type { SemaTaxScenario } from "../../src/schemas.js";

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

async function load(): Promise<{
  scenario: SemaTaxScenario;
  patternsByHandle: Map<string, SemaTaxSizedPattern>;
}> {
  const { fixtureSet, patternsByHandle } =
    await loadSizeReuseFixtureFile(FIXTURE_PATH);
  const scenario = fixtureSet.scenarios.find(
    (s) => s.id === "settlement-desk",
  )!;
  return { scenario, patternsByHandle };
}

function cellFor(
  scenario: SemaTaxScenario,
  condition: string,
  seed = 0,
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

async function runOne(
  scenario: SemaTaxScenario,
  patternsByHandle: Map<string, SemaTaxSizedPattern>,
  condition: string,
  seed = 0,
) {
  return runSimulatedSizeReuseTrial(cellFor(scenario, condition, seed), {
    experimentId: "sema-tax",
    referenceProvider: new FixtureReferenceProvider(),
    patternsByHandle,
    provenance,
  });
}

describe("runSimulatedSizeReuseTrial scoring", () => {
  it("scores each message at the p8 coverage and means them for the trial", async () => {
    const { scenario, patternsByHandle } = await load();
    // settlement-desk items reference pool positions [0,1,3,5,7,10,13,15]; at p8
    // the active set is positions 0..7, covering {0,1,3,5,7} = 5 of 8 items.
    for (const condition of [
      "p8-small-r1-prose-cold",
      "p8-medium-r3-content-cold",
      "p8-large-r9-opaque-cold",
    ]) {
      const record = await runOne(scenario, patternsByHandle, condition);
      const parts = record.metrics;
      expect(parts.score).toBeCloseTo(5 / 8, 10);
      expect(parts.messages).toHaveLength(parts.reuse);
      for (const message of parts.messages) {
        expect(message.score).toBeCloseTo(5 / 8, 10);
        expect(message.itemsTotal).toBe(8);
        expect(message.itemsAnswered).toBe(8); // fully compliant simulator
        expect(message.itemsCorrect).toBe(5);
      }
      // Item accounting sums across the R messages.
      expect(parts.itemsAnswered).toBe(8 * parts.reuse);
      expect(parts.itemsCorrect).toBe(5 * parts.reuse);
      expect(parts.itemsTotal).toBe(8 * parts.reuse);
      expect(parts.taskSuccess).toBe(false);
    }
  });

  it("marks task success only when every message covers every item", async () => {
    // oracle-guardrails at p8: active positions 0..7 cover exactly its items.
    const { fixtureSet, patternsByHandle } =
      await loadSizeReuseFixtureFile(FIXTURE_PATH);
    const scenario = fixtureSet.scenarios.find(
      (s) => s.id === "oracle-guardrails",
    )!;
    const record = await runOne(
      scenario,
      patternsByHandle,
      "p8-medium-r3-content-cold",
    );
    // Whether it is a full cover depends on the fixture; assert the invariant
    // that taskSuccess iff mean score is 1.
    expect(record.metrics.taskSuccess).toBe(record.metrics.score === 1);
  });
});

describe("runSimulatedSizeReuseTrial reuse accounting", () => {
  it("scales prose wire with R and never hydrates", async () => {
    const { scenario, patternsByHandle } = await load();
    const r1 = await runOne(
      scenario,
      patternsByHandle,
      "p8-medium-r1-prose-cold",
    );
    const r3 = await runOne(
      scenario,
      patternsByHandle,
      "p8-medium-r3-prose-cold",
    );
    const r9 = await runOne(
      scenario,
      patternsByHandle,
      "p8-medium-r9-prose-cold",
    );
    expect(r1.metrics.cumulativeHydrationBytes).toBe(0);
    expect(r3.metrics.cumulativeHydrationBytes).toBe(0);
    expect(r9.metrics.cumulativeHydrationBytes).toBe(0);
    // Prose wire is exactly linear in R (identical message repeated).
    expect(r3.metrics.cumulativeWireBytes).toBe(
      3 * r1.metrics.cumulativeWireBytes,
    );
    expect(r9.metrics.cumulativeWireBytes).toBe(
      9 * r1.metrics.cumulativeWireBytes,
    );
    // Total semantic bytes == wire (no hydration) and total tokens scale ×R too.
    expect(r3.metrics.totalSemanticBytes).toBe(r3.metrics.cumulativeWireBytes);
    expect(r3.metrics.totalModelTokens).toBe(3 * r1.metrics.totalModelTokens);
    expect(r9.metrics.totalModelTokens).toBe(9 * r1.metrics.totalModelTokens);
  });

  it("holds resolver hydration constant in R while wire scales with R", async () => {
    const { scenario, patternsByHandle } = await load();
    for (const delivery of ["opaque", "content"] as const) {
      const r1 = await runOne(
        scenario,
        patternsByHandle,
        `p8-medium-r1-${delivery}-cold`,
      );
      const r3 = await runOne(
        scenario,
        patternsByHandle,
        `p8-medium-r3-${delivery}-cold`,
      );
      const r9 = await runOne(
        scenario,
        patternsByHandle,
        `p8-medium-r9-${delivery}-cold`,
      );
      // Hydration is paid once and does not grow with R.
      expect(r1.metrics.cumulativeHydrationBytes).toBeGreaterThan(0);
      expect(r3.metrics.cumulativeHydrationBytes).toBe(
        r1.metrics.cumulativeHydrationBytes,
      );
      expect(r9.metrics.cumulativeHydrationBytes).toBe(
        r1.metrics.cumulativeHydrationBytes,
      );
      // Exactly one message carries hydration bytes; the rest carry none.
      expect(
        r9.metrics.messages.filter((m) => m.hydrationBytes > 0),
      ).toHaveLength(1);
      // Reference wire scales linearly with R.
      expect(r3.metrics.cumulativeWireBytes).toBe(
        3 * r1.metrics.cumulativeWireBytes,
      );
      // Tokens are strictly sub-linear in R: the definitions are ingested once,
      // so R messages cost less than R times a single message.
      expect(r3.metrics.totalModelTokens).toBeLessThan(
        3 * r1.metrics.totalModelTokens,
      );
    }
  });

  it("shows the content arm crossing prose on total semantic bytes as size×R grows", async () => {
    const { scenario, patternsByHandle } = await load();
    // Worst case for references (small, R1): prose is cheaper.
    const proseSmall = await runOne(
      scenario,
      patternsByHandle,
      "p8-small-r1-prose-cold",
    );
    const contentSmall = await runOne(
      scenario,
      patternsByHandle,
      "p8-small-r1-content-cold",
    );
    expect(contentSmall.metrics.totalSemanticBytes).toBeGreaterThan(
      proseSmall.metrics.totalSemanticBytes,
    );
    // Large definitions reused nine times: the resolver arm wins decisively.
    const proseLarge = await runOne(
      scenario,
      patternsByHandle,
      "p8-large-r9-prose-cold",
    );
    const contentLarge = await runOne(
      scenario,
      patternsByHandle,
      "p8-large-r9-content-cold",
    );
    expect(contentLarge.metrics.totalSemanticBytes).toBeLessThan(
      proseLarge.metrics.totalSemanticBytes,
    );
    expect(contentLarge.metrics.totalModelTokens).toBeLessThan(
      proseLarge.metrics.totalModelTokens,
    );
  });
});

describe("runSimulatedSizeReuseTrial matrix", () => {
  it("runs the full 27-condition grid producing schema-valid records", async () => {
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
    const records = await executeMatrix(cells, (cell) =>
      runSimulatedSizeReuseTrial(cell, {
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
      expect(semaTaxSizeReuseTrialRecordSchema.safeParse(record).success).toBe(
        true,
      );
      expect(record.usage).toBeNull();
      expect(record.transcript).toBeNull();
      expect(record.metrics.messages).toHaveLength(record.metrics.reuse);
    }
  });

  it("is deterministic across repetition seeds", async () => {
    const { scenario, patternsByHandle } = await load();
    const a = await runOne(
      scenario,
      patternsByHandle,
      "p8-large-r3-content-cold",
      0,
    );
    const b = await runOne(
      scenario,
      patternsByHandle,
      "p8-large-r3-content-cold",
      1,
    );
    expect(a.metrics.totalSemanticBytes).toBe(b.metrics.totalSemanticBytes);
    expect(a.metrics.totalModelTokens).toBe(b.metrics.totalModelTokens);
    expect(a.metrics.score).toBe(b.metrics.score);
  });
});
