import { describe, expect, it } from "vitest";

import type {
  ExperimentCondition,
  ResultManifest,
} from "../../packages/core/src/schemas.js";
import { aggregateTrials, type SiteAggregate } from "../lib/aggregate.js";
import {
  computeRunFindings,
  renderFindingsPanel,
  renderInterpretation,
  selectLargestPilotRunPerModel,
  type RunView,
} from "../lib/render.js";
import { getInterpretation } from "../site-content/interpretations.js";
import { makeTrial } from "./fixtures.js";

const HEX64 = "a".repeat(64);

interface ConditionSpec {
  condition: ExperimentCondition;
  trials: number;
  successes: number;
  drift: number;
  silentDiv: number;
  falseHalt: number;
}

// Build `trials` records for one condition with independent flag counts, so the
// recomputed aggregate has exactly the rates a test asserts against.
function buildCondition(spec: ConditionSpec) {
  const records = [];
  for (let i = 0; i < spec.trials; i += 1) {
    records.push(
      makeTrial({
        scenarioId: "s1",
        condition: spec.condition,
        seed: i,
        metrics: {
          taskSuccess: i < spec.successes,
          driftInjected: i < spec.drift,
          silentDivergence: i < spec.silentDiv,
          falseHalt: i < spec.falseHalt,
        },
      }),
    );
  }
  return records;
}

function aggregateFrom(specs: ConditionSpec[]): SiteAggregate {
  return aggregateTrials(specs.flatMap(buildCondition));
}

function makeManifest(overrides: Partial<ResultManifest> = {}): ResultManifest {
  return {
    artifactSchemaVersion: "0.3.0",
    protocolVersion: "0.3.0",
    experimentId: "babel-relay",
    runId: "20260714T000000000Z-order-20260714",
    mode: "model-pilot",
    evidenceClaim: "Exploratory model pilot. Not confirmatory evidence.",
    createdAt: "2026-07-14T00:00:00.000Z",
    orderSeed: 20260714,
    seeds: [0],
    conditions: ["baseline"],
    scenarioCount: 1,
    trialCount: 1,
    fixtureDigest: HEX64,
    provenance: {
      artifactSchemaVersion: "0.3.0",
      protocolVersion: "0.3.0",
      fixtureDigest: HEX64,
      implementationCommit: "abc123",
      dependencyLockDigest: HEX64,
      promptDigest: HEX64,
      semaVersion: "not-connected",
      canonicalizationVersion: "fixture-stable-json-v1",
      vocabularyRoot: "",
      semanticBackend: "fixture-sha256-stable-json-v1",
      modelProvider: "llm.example",
      modelName: "example/model",
    },
    ...overrides,
  };
}

// A five-condition aggregate with clean, exact per-condition task-success rates:
// baseline .2, equal-prose .5, opaque-resolver .4, addressed-voluntary .6,
// addressed-enforced .9 → Content +30, Lookup -10, Detection +10, Enforcement +30.
function fiveConditionAggregate(): SiteAggregate {
  return aggregateFrom([
    {
      condition: "baseline",
      trials: 10,
      successes: 2,
      drift: 6,
      silentDiv: 5,
      falseHalt: 0,
    },
    {
      condition: "equal-prose",
      trials: 10,
      successes: 5,
      drift: 6,
      silentDiv: 3,
      falseHalt: 0,
    },
    {
      condition: "opaque-resolver",
      trials: 10,
      successes: 4,
      drift: 6,
      silentDiv: 3,
      falseHalt: 0,
    },
    {
      condition: "addressed-voluntary",
      trials: 10,
      successes: 6,
      drift: 6,
      silentDiv: 0,
      falseHalt: 1,
    },
    {
      condition: "addressed-enforced",
      trials: 10,
      successes: 9,
      drift: 6,
      silentDiv: 0,
      falseHalt: 2,
    },
  ]);
}

function makeRunView(
  aggregate: SiteAggregate,
  manifest: ResultManifest,
): RunView {
  return { manifest, aggregate, dataDir: manifest.runId };
}

describe("computeRunFindings", () => {
  it("derives exact decomposition effects and addressed-arm safety figures", () => {
    const f = computeRunFindings(fiveConditionAggregate());
    expect(f.content).toBeCloseTo(30, 6); // equal-prose .5 − baseline .2
    expect(f.lookup).toBeCloseTo(-10, 6); // opaque-resolver .4 − equal-prose .5
    expect(f.detection).toBeCloseTo(10, 6); // addressed-voluntary .6 − equal-prose .5
    expect(f.enforcement).toBeCloseTo(30, 6); // addressed-enforced .9 − addressed-voluntary .6
    // Silent divergences summed over both addressed arms (0 + 0), over 6 + 6 drift trials.
    expect(f.addressedSilentDivergences).toBe(0);
    expect(f.addressedDriftTrials).toBe(12);
    // Enforced-arm false halts and denominator.
    expect(f.enforcedFalseHalts).toBe(2);
    expect(f.enforcedTrials).toBe(10);
  });

  it("returns null effects when a needed condition is absent", () => {
    const f = computeRunFindings(
      aggregateFrom([
        {
          condition: "baseline",
          trials: 4,
          successes: 1,
          drift: 2,
          silentDiv: 1,
          falseHalt: 0,
        },
      ]),
    );
    expect(f.content).toBeNull();
    expect(f.enforcement).toBeNull();
    expect(f.enforcedFalseHalts).toBeNull();
    expect(f.enforcedTrials).toBeNull();
  });
});

describe("selectLargestPilotRunPerModel", () => {
  it("keeps only the largest model-pilot run per model, ordered by model name", () => {
    const agg = fiveConditionAggregate();
    const runs: RunView[] = [
      makeRunView(
        agg,
        makeManifest({
          runId: "nemo-150",
          trialCount: 150,
          provenance: {
            ...makeManifest().provenance,
            modelName: "vendor/Nemo",
          },
        }),
      ),
      makeRunView(
        agg,
        makeManifest({
          runId: "nemo-900",
          trialCount: 900,
          provenance: {
            ...makeManifest().provenance,
            modelName: "vendor/Nemo",
          },
        }),
      ),
      makeRunView(
        agg,
        makeManifest({
          runId: "minimax-900",
          trialCount: 900,
          provenance: {
            ...makeManifest().provenance,
            modelName: "vendor/MiniMax",
          },
        }),
      ),
      // A non-pilot run must be excluded entirely.
      makeRunView(
        agg,
        makeManifest({
          runId: "harness",
          mode: "deterministic-harness",
          trialCount: 5000,
          provenance: {
            ...makeManifest().provenance,
            modelName: "vendor/Harness",
          },
        }),
      ),
    ];
    const selected = selectLargestPilotRunPerModel(runs);
    expect(selected.map((r) => r.manifest.runId)).toEqual([
      "minimax-900",
      "nemo-900",
    ]);
  });
});

describe("renderFindingsPanel", () => {
  function twoModelRuns(): RunView[] {
    const agg = fiveConditionAggregate();
    return [
      makeRunView(
        agg,
        makeManifest({
          runId: "minimax-900",
          trialCount: 900,
          provenance: {
            ...makeManifest().provenance,
            modelName: "vendor/MiniMax",
          },
        }),
      ),
      makeRunView(
        agg,
        makeManifest({
          runId: "nemo-900",
          trialCount: 900,
          provenance: {
            ...makeManifest().provenance,
            modelName: "vendor/Nemo",
          },
        }),
      ),
    ];
  }

  it("renders the effects table and a dumbbell with a zero line, legend and both series", () => {
    const html = renderFindingsPanel("babel-relay", twoModelRuns());
    expect(html).toContain('<div class="findings">');
    expect(html).toContain("Findings so far");
    expect(html).toContain('<table class="effects">');
    // Dumbbell: emphasised zero line, legend, and both categorical series present.
    expect(html).toContain('class="chart-zero"');
    expect(html).toContain('<div class="chart-legend">');
    expect(html).toContain("dumbbell-a");
    expect(html).toContain("dumbbell-b");
    expect(html).toContain("swatch-a");
    expect(html).toContain("swatch-b");
    // One axis only: no vertical/left axis ticks beyond the single x scale row.
    expect(html).toContain("Content");
    expect(html).toContain("Enforcement");
    // Direct value labels (the static-chart compensation) ride the dots.
    expect(html).toContain("+30.0");
    expect(html).toContain("-10.0");
  });

  it("is byte-identical across repeated renders", () => {
    const runs = twoModelRuns();
    expect(renderFindingsPanel("babel-relay", runs)).toEqual(
      renderFindingsPanel("babel-relay", runs),
    );
  });

  it("renders nothing when the experiment has no model-pilot runs", () => {
    const runs = [
      makeRunView(
        fiveConditionAggregate(),
        makeManifest({ mode: "deterministic-harness" }),
      ),
    ];
    expect(renderFindingsPanel("babel-relay", runs)).toBe("");
  });
});

describe("interpretation coverage gate", () => {
  it("renders the note when every promoted run is covered", () => {
    const covered = getInterpretation("babel-relay")!.coveredRunIds;
    const html = renderInterpretation("babel-relay", covered);
    expect(html).toContain('<div class="interpretation">');
    expect(html).toContain("as of 2026-07-15");
    expect(html).toContain("exploratory pilots");
  });

  it("throws naming the missing run when a promoted run is not covered", () => {
    const covered = getInterpretation("babel-relay")!.coveredRunIds;
    const uncovered = "20260716T000000000Z-order-20260716";
    expect(() =>
      renderInterpretation("babel-relay", [...covered, uncovered]),
    ).toThrow(uncovered);
  });

  it("renders nothing for an experiment with no interpretation copy", () => {
    expect(renderInterpretation("unknown-experiment", ["some-run"])).toBe("");
  });

  it("renders nothing when the experiment has no promoted runs", () => {
    expect(renderInterpretation("babel-relay", [])).toBe("");
  });
});
