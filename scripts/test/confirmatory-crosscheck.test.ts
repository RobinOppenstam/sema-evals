// -------------------------------------------------------------------------
// Confirmatory analysis cross-check + adapter integration
//
// The site recomputes a confirmatory run's analysis from its public trials. If a
// bundle also ships an analysis.json, the adapter cross-checks it and FAILS the
// build on any disagreement (same discipline as the summary recompute). These
// tests cover the cross-check comparator directly and end-to-end through the
// babel-relay adapter over a temporary public root.
// -------------------------------------------------------------------------

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ExperimentCondition,
  ResultManifest,
  TrialRecord,
} from "../../packages/core/src/schemas.js";
import { analyzeArm } from "../../experiments/babel-relay/src/confirmatory-analysis.js";
import { babelRelayAdapter } from "../lib/adapters/babel-relay.js";
import { assertAnalysisFaithful } from "../lib/adapter-support.js";
import { crossCheckAnalysis } from "../lib/confirmatory-crosscheck.js";
import { makeTrial } from "./fixtures.js";

const HEX64 = "a".repeat(64);
const PREREG_PATH =
  "docs/preregistrations/prereg-001-babel-relay-confirmatory.md";
const PREREG_DIGEST =
  "40be2c73dbec9beb8f46ab27d6b56c53c94c4372cca2d1647e235e6085fb46b7";
const NEMO = "unsloth/Mistral-Nemo-Instruct-2407-TEE";
// A runId covered by the babel-relay interpretation note, so the coverage gate
// in renderBabelRelaySection is satisfied for this temp-root build.
const COVERED_RUN_ID = "20260714T170651223Z-order-20260714";

interface ConditionSpec {
  condition: ExperimentCondition;
  driftTrials: number;
  silentDivergences: number;
  controlTrials: number;
  taskSuccesses: number;
}

function buildCondition(spec: ConditionSpec): TrialRecord[] {
  const records: TrialRecord[] = [];
  const total = spec.driftTrials + spec.controlTrials;
  for (let i = 0; i < total; i += 1) {
    const isDrift = i < spec.driftTrials;
    records.push(
      makeTrial({
        scenarioId: "s1",
        condition: spec.condition,
        seed: i,
        metrics: {
          driftInjected: isDrift,
          driftDetected: isDrift && !(i < spec.silentDivergences),
          silentDivergence: isDrift && i < spec.silentDivergences,
          taskSuccess: i < spec.taskSuccesses,
        },
      }),
    );
  }
  return records;
}

function confirmingRecords(): TrialRecord[] {
  return [
    ...buildCondition({
      condition: "baseline",
      driftTrials: 120,
      silentDivergences: 115,
      controlTrials: 60,
      taskSuccesses: 60,
    }),
    ...buildCondition({
      condition: "equal-prose",
      driftTrials: 120,
      silentDivergences: 110,
      controlTrials: 60,
      taskSuccesses: 70,
    }),
    ...buildCondition({
      condition: "opaque-resolver",
      driftTrials: 120,
      silentDivergences: 108,
      controlTrials: 60,
      taskSuccesses: 72,
    }),
    ...buildCondition({
      condition: "addressed-voluntary",
      driftTrials: 120,
      silentDivergences: 0,
      controlTrials: 60,
      taskSuccesses: 60,
    }),
    ...buildCondition({
      condition: "addressed-enforced",
      driftTrials: 120,
      silentDivergences: 0,
      controlTrials: 60,
      taskSuccesses: 170,
    }),
  ];
}

function confirmatoryManifest(runId: string): ResultManifest {
  return {
    artifactSchemaVersion: "0.3.0",
    protocolVersion: "0.3.0",
    experimentId: "babel-relay",
    runId,
    mode: "confirmatory",
    evidenceClaim:
      "Preregistered confirmatory experiment. Hypotheses were fixed at registration.",
    createdAt: "2026-07-16T00:00:00.000Z",
    orderSeed: 20260716,
    seeds: [0],
    conditions: [
      "baseline",
      "equal-prose",
      "opaque-resolver",
      "addressed-voluntary",
      "addressed-enforced",
    ],
    scenarioCount: 1,
    trialCount: 900,
    fixtureDigest: HEX64,
    provenance: {
      artifactSchemaVersion: "0.3.0",
      protocolVersion: "0.3.0",
      fixtureDigest: HEX64,
      implementationCommit: "e83e10377d74620f854627d641e047537110a992",
      dependencyLockDigest: HEX64,
      promptDigest: HEX64,
      semaVersion: "0.3.0",
      canonicalizationVersion: "v2",
      vocabularyRoot: "root",
      semanticBackend: "fixture",
      modelProvider: "llm.chutes.ai",
      modelName: NEMO,
      preregistrationPath: PREREG_PATH,
      preregistrationDigest: PREREG_DIGEST,
    },
  };
}

describe("crossCheckAnalysis", () => {
  const records = confirmingRecords();
  const recomputed = analyzeArm({
    arm: NEMO,
    mode: "confirmatory",
    trials: records,
  });

  it("returns no warnings when the shipped analysis matches (ModelAnalysis shape)", () => {
    const shipped = JSON.parse(JSON.stringify(recomputed));
    expect(crossCheckAnalysis(recomputed, shipped, NEMO)).toEqual([]);
  });

  it("resolves the arm out of a ConfirmatoryReport shape", () => {
    const report = { models: [JSON.parse(JSON.stringify(recomputed))] };
    expect(crossCheckAnalysis(recomputed, report, NEMO)).toEqual([]);
  });

  it("flags a disagreeing hypothesis pass", () => {
    const shipped = JSON.parse(JSON.stringify(recomputed));
    const h3 = shipped.hypotheses.find((c: { id: string }) => c.id === "H3");
    h3.pass = !h3.pass;
    const warnings = crossCheckAnalysis(recomputed, shipped, NEMO);
    expect(warnings.join(" ")).toMatch(/H3.*\.pass/);
  });

  it("flags a disagreeing interval bound", () => {
    const shipped = JSON.parse(JSON.stringify(recomputed));
    const h1 = shipped.hypotheses.find((c: { id: string }) => c.id === "H1");
    h1.interval.upper = h1.interval.upper + 0.5;
    const warnings = crossCheckAnalysis(recomputed, shipped, NEMO);
    expect(warnings.join(" ")).toMatch(/interval\.upper/);
  });

  it("flags a disagreeing exclusion count and infrastructure-invalid flag", () => {
    const shipped = JSON.parse(JSON.stringify(recomputed));
    shipped.exclusions.excluded = 99;
    shipped.exclusions.infrastructureInvalid = true;
    const warnings = crossCheckAnalysis(recomputed, shipped, NEMO);
    expect(warnings.join(" ")).toMatch(/exclusions\.excluded/);
    expect(warnings.join(" ")).toMatch(/exclusions\.infrastructureInvalid/);
  });

  it("warns when no arm matches", () => {
    const shipped = { models: [{ arm: "other/model" }] };
    expect(crossCheckAnalysis(recomputed, shipped, NEMO)[0]).toMatch(
      /ships no arm matching/,
    );
  });
});

describe("assertAnalysisFaithful", () => {
  it("is a no-op on no warnings and throws on any", () => {
    expect(() => assertAnalysisFaithful("babel-relay", "r", [])).not.toThrow();
    expect(() =>
      assertAnalysisFaithful("babel-relay", "r", [
        "H3.pass: analysis=false recomputed=true",
      ]),
    ).toThrow(/analysis\.json disagrees/);
  });
});

describe("babel-relay adapter — confirmatory integration", () => {
  let publicRoot: string;
  let experimentDir: string;

  beforeEach(async () => {
    publicRoot = await mkdtemp(join(tmpdir(), "sema-confirm-"));
    experimentDir = join(publicRoot, "babel-relay");
  });

  afterEach(async () => {
    await rm(publicRoot, { recursive: true, force: true });
  });

  async function writeBundle(
    runId: string,
    records: TrialRecord[],
    analysisJson?: unknown,
  ): Promise<void> {
    const runDir = join(experimentDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "manifest.json"),
      JSON.stringify(confirmatoryManifest(runId)),
      "utf8",
    );
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ trialCount: records.length, scenarioCount: 1 }),
      "utf8",
    );
    await writeFile(
      join(runDir, "trials.public.jsonl"),
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );
    if (analysisJson !== undefined) {
      await writeFile(
        join(runDir, "analysis.json"),
        JSON.stringify(analysisJson),
        "utf8",
      );
    }
  }

  it("renders the hypotheses panel and the pending cross-arm verdict", async () => {
    const records = confirmingRecords();
    await writeBundle(COVERED_RUN_ID, records);
    const loaded = await babelRelayAdapter.loadExperiment(experimentDir, [
      COVERED_RUN_ID,
    ]);
    const runPage = loaded.runs[0]!.runBody;
    expect(runPage).toContain("Preregistered hypotheses");
    expect(runPage).toContain('<span class="pf pf-pass">PASS</span>');
    // The experiment page shows the cross-arm verdict block (1 of 3 arms).
    expect(loaded.experimentBody).toContain("Confirmatory verdict");
    expect(loaded.experimentBody).toContain("1 of 3 registered arms published");
    // Overview card surfaces the confirmatory status.
    expect(loaded.overviewCard).toContain("pending (1 of 3 arms)");
  });

  it("passes when a matching analysis.json ships alongside the trials", async () => {
    const records = confirmingRecords();
    const analysis = analyzeArm({
      arm: NEMO,
      mode: "confirmatory",
      trials: records,
    });
    await writeBundle(COVERED_RUN_ID, records, analysis);
    await expect(
      babelRelayAdapter.loadExperiment(experimentDir, [COVERED_RUN_ID]),
    ).resolves.toBeDefined();
  });

  it("FAILS the build when a shipped analysis.json disagrees", async () => {
    const records = confirmingRecords();
    const analysis = analyzeArm({
      arm: NEMO,
      mode: "confirmatory",
      trials: records,
    });
    const tampered = JSON.parse(JSON.stringify(analysis));
    tampered.hypotheses.find((c: { id: string }) => c.id === "H3").pass = false;
    await writeBundle(COVERED_RUN_ID, records, tampered);
    await expect(
      babelRelayAdapter.loadExperiment(experimentDir, [COVERED_RUN_ID]),
    ).rejects.toThrow(/analysis\.json disagrees/);
  });
});
