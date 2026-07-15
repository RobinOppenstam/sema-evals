import { describe, expect, it } from "vitest";

import type {
  ExperimentCondition,
  TrialEvent,
  TrialProvenance,
  TrialRecord,
} from "@sema-evals/core";

import {
  analyzeArm,
  analyzeReport,
  renderReportMarkdown,
  trialHopFailed,
  type ArmInput,
} from "../src/confirmatory-analysis.js";

const PROVENANCE: TrialProvenance = {
  artifactSchemaVersion: "0.3.0",
  protocolVersion: "0.3.0",
  fixtureDigest: "a".repeat(64),
  implementationCommit: "commit",
  dependencyLockDigest: "b".repeat(64),
  promptDigest: "c".repeat(64),
  semaVersion: "0.3.0",
  canonicalizationVersion: "v2",
  vocabularyRoot: "root",
  semanticBackend: "fixture",
  modelProvider: "llm.chutes.ai",
  modelName: "test/model",
};

interface MetricSpec {
  driftInjected: boolean;
  silentDivergence: boolean;
  taskSuccess: boolean;
  falseHalt: boolean;
  hopFailed: boolean;
}

let counter = 0;

function trial(condition: ExperimentCondition, spec: MetricSpec): TrialRecord {
  counter += 1;
  const events: TrialEvent[] = [
    {
      sequence: 0,
      type: "completion",
      boundary: null,
      agent: "audit-agent",
      details: { hopFailed: spec.hopFailed },
    },
  ];
  return {
    trialId: counter.toString(16).padStart(64, "0"),
    experimentId: "babel-relay",
    scenarioId: "scenario",
    condition,
    seed: 0,
    executionIndex: counter,
    startedAt: "2026-07-16T00:00:00.000Z",
    completedAt: "2026-07-16T00:00:01.000Z",
    expectedAction: spec.driftInjected ? "halt" : "proceed",
    actualAction: "proceed",
    events,
    metrics: {
      driftInjected: spec.driftInjected,
      driftDetected: spec.driftInjected && !spec.silentDivergence,
      halted: false,
      silentDivergence: spec.silentDivergence,
      correctHalt: false,
      falseHalt: spec.falseHalt,
      taskSuccess: spec.taskSuccess,
      detectionBoundary: null,
      wireBytes: 0,
      hydrationBytes: 0,
      totalSemanticBytes: 0,
      elapsedMs: 0,
    },
    provenance: PROVENANCE,
    usage: null,
    transcript: null,
  };
}

interface ConditionSpec {
  /** Drift trials, and how many of them are silent divergences. */
  driftTrials: number;
  silentDivergences: number;
  /** Non-drift trials (controls). */
  controlTrials: number;
  /** Task successes across all trials in the condition. */
  taskSuccesses: number;
  falseHalts?: number;
  hopFailed?: number;
}

function buildCondition(
  condition: ExperimentCondition,
  spec: ConditionSpec,
): TrialRecord[] {
  const rows: TrialRecord[] = [];
  const total = spec.driftTrials + spec.controlTrials;
  const falseHalts = spec.falseHalts ?? 0;
  const hopFailed = spec.hopFailed ?? 0;
  for (let i = 0; i < total; i += 1) {
    const isDrift = i < spec.driftTrials;
    rows.push(
      trial(condition, {
        driftInjected: isDrift,
        silentDivergence: isDrift && i < spec.silentDivergences,
        taskSuccess: i < spec.taskSuccesses,
        falseHalt: i >= total - falseHalts,
        // hopFailed trials sit at the front, overlapping drift trials, so
        // exclusion visibly shrinks the drift-based endpoints.
        hopFailed: i < hopFailed,
      }),
    );
  }
  return rows;
}

/** A clean, fully-confirming arm shaped like the pilot decomposition. */
function confirmingArm(model: string): ArmInput {
  const trials = [
    ...buildCondition("baseline", {
      driftTrials: 120,
      silentDivergences: 115,
      controlTrials: 60,
      taskSuccesses: 60,
    }),
    ...buildCondition("equal-prose", {
      driftTrials: 120,
      silentDivergences: 110,
      controlTrials: 60,
      taskSuccesses: 70,
    }),
    ...buildCondition("opaque-resolver", {
      driftTrials: 120,
      silentDivergences: 108,
      controlTrials: 60,
      taskSuccesses: 72,
    }),
    ...buildCondition("addressed-voluntary", {
      driftTrials: 120,
      silentDivergences: 0,
      controlTrials: 60,
      taskSuccesses: 60,
    }),
    ...buildCondition("addressed-enforced", {
      driftTrials: 120,
      silentDivergences: 0,
      controlTrials: 60,
      taskSuccesses: 170,
    }),
  ];
  return { arm: model, mode: "confirmatory", trials };
}

describe("trialHopFailed", () => {
  it("reads the completion event's hopFailed flag", () => {
    const failed = trial("baseline", {
      driftInjected: true,
      silentDivergence: false,
      taskSuccess: false,
      falseHalt: false,
      hopFailed: true,
    });
    const ok = trial("baseline", {
      driftInjected: true,
      silentDivergence: true,
      taskSuccess: false,
      falseHalt: false,
      hopFailed: false,
    });
    expect(trialHopFailed(failed)).toBe(true);
    expect(trialHopFailed(ok)).toBe(false);
  });
});

describe("analyzeArm — confirming arm", () => {
  const analysis = analyzeArm(confirmingArm("test/model"));

  it("passes H1 in both addressed arms (0 silent divergences)", () => {
    const h1 = analysis.hypotheses.filter((h) => h.id === "H1");
    expect(h1).toHaveLength(2);
    for (const check of h1) {
      expect(check.numerator).toBe(0);
      expect(check.denominator).toBe(120);
      expect(check.interval.upper).toBeCloseTo(0.030273, 4);
      expect(check.pass).toBe(true);
    }
  });

  it("passes H2 with a large enforced-minus-voluntary gap", () => {
    const h2 = analysis.hypotheses.find((h) => h.id === "H2")!;
    // 170/180 - 60/180 = +61.1pp.
    expect(h2.pointEstimate).toBeCloseTo(110 / 180, 6);
    expect(h2.interval.lower).toBeGreaterThan(0.15);
    expect(h2.pass).toBe(true);
  });

  it("passes H3 with a high baseline silent-divergence floor", () => {
    const h3 = analysis.hypotheses.find((h) => h.id === "H3")!;
    expect(h3.numerator).toBe(115);
    expect(h3.denominator).toBe(120);
    expect(h3.interval.lower).toBeGreaterThan(0.5);
    expect(h3.pass).toBe(true);
  });

  it("reports the three secondary descriptive effects", () => {
    expect(analysis.descriptive.map((e) => e.id)).toEqual([
      "content-effect",
      "lookup-effect",
      "detection-alone-effect",
    ]);
  });

  it("confirms the arm with no exclusions", () => {
    expect(analysis.exclusions.excluded).toBe(0);
    expect(analysis.exclusions.infrastructureInvalid).toBe(false);
    expect(analysis.confirmed).toBe(true);
    expect(analysis.failures).toEqual([]);
  });
});

describe("analyzeArm — exclusions and the 2% invalid-arm flag", () => {
  it("excludes hopFailed trials from endpoint math and counts them", () => {
    // 900 trials, 10 hopFailed spread only in baseline drift -> 1.1% (valid).
    const arm = confirmingArm("test/model");
    // Rebuild baseline with 10 hopFailed among its drift trials.
    const trials = [
      ...buildCondition("baseline", {
        driftTrials: 120,
        silentDivergences: 115,
        controlTrials: 60,
        taskSuccesses: 60,
        hopFailed: 10,
      }),
      ...arm.trials.filter((t) => t.condition !== "baseline"),
    ];
    const analysis = analyzeArm({
      arm: "test/model",
      mode: "confirmatory",
      trials,
    });
    expect(analysis.exclusions.excluded).toBe(10);
    expect(analysis.exclusions.byCondition.baseline).toBe(10);
    expect(analysis.exclusions.infrastructureInvalid).toBe(false);
    // H3 denominator shrinks: 10 of the last drift/control rows were failed.
    const h3 = analysis.hypotheses.find((h) => h.id === "H3")!;
    expect(h3.denominator).toBeLessThan(120);
  });

  it("flags an arm infrastructure-invalid above 2% exclusions", () => {
    const trials = [
      ...buildCondition("baseline", {
        driftTrials: 120,
        silentDivergences: 115,
        controlTrials: 60,
        taskSuccesses: 60,
        hopFailed: 40,
      }),
      ...confirmingArm("m").trials.filter((t) => t.condition !== "baseline"),
    ];
    const analysis = analyzeArm({ arm: "m", mode: "confirmatory", trials });
    // 40 / 900 = 4.4% > 2%.
    expect(analysis.exclusions.excludedRate).toBeCloseTo(40 / 900, 6);
    expect(analysis.exclusions.infrastructureInvalid).toBe(true);
    expect(analysis.confirmed).toBe(false);
    expect(analysis.failures.join(" ")).toMatch(/infrastructure-invalid/);
  });
});

describe("analyzeArm — failing hypotheses", () => {
  it("fails H1 when an addressed arm has 2 silent divergences", () => {
    const trials = [
      ...confirmingArm("m").trials.filter(
        (t) => t.condition !== "addressed-enforced",
      ),
      ...buildCondition("addressed-enforced", {
        driftTrials: 120,
        silentDivergences: 2,
        controlTrials: 60,
        taskSuccesses: 170,
      }),
    ];
    const analysis = analyzeArm({ arm: "m", mode: "confirmatory", trials });
    const h1Enforced = analysis.hypotheses.find(
      (h) => h.id === "H1" && h.condition === "addressed-enforced",
    )!;
    expect(h1Enforced.interval.upper).toBeGreaterThan(0.05);
    expect(h1Enforced.pass).toBe(false);
    expect(analysis.confirmed).toBe(false);
    expect(analysis.failures.join(" ")).toMatch(/H1.*addressed-enforced/);
  });
});

describe("analyzeReport — conjunctive verdict", () => {
  it("confirms when every arm confirms", () => {
    const report = analyzeReport(
      ["a", "b"],
      [confirmingArm("model-a"), confirmingArm("model-b")],
    );
    expect(report.verdict).toBe("confirmed");
  });

  it("is partial when some but not all arms confirm", () => {
    const failing = confirmingArm("model-b");
    const brokenTrials = [
      ...failing.trials.filter((t) => t.condition !== "baseline"),
      ...buildCondition("baseline", {
        driftTrials: 120,
        silentDivergences: 30, // 25% -> H3 lower well below 50%.
        controlTrials: 60,
        taskSuccesses: 60,
      }),
    ];
    const report = analyzeReport(
      ["a", "b"],
      [
        confirmingArm("model-a"),
        { arm: "model-b", mode: "confirmatory", trials: brokenTrials },
      ],
    );
    expect(report.verdict).toBe("partial");
    expect(report.verdictDetail).toMatch(/model-b/);
    expect(report.verdictDetail).toMatch(/H3/);
  });

  it("refutes when no arm confirms", () => {
    const brokenTrials = [
      ...buildCondition("baseline", {
        driftTrials: 120,
        silentDivergences: 30,
        controlTrials: 60,
        taskSuccesses: 60,
      }),
      ...confirmingArm("m").trials.filter((t) => t.condition !== "baseline"),
    ];
    const report = analyzeReport(
      ["a"],
      [{ arm: "model-a", mode: "confirmatory", trials: brokenTrials }],
    );
    expect(report.verdict).toBe("refuted");
  });
});

describe("renderReportMarkdown", () => {
  it("renders a deterministic markdown report", () => {
    const report = analyzeReport(["bundle-a"], [confirmingArm("test/model")]);
    const first = renderReportMarkdown(report);
    const second = renderReportMarkdown(report);
    expect(first).toBe(second);
    expect(first).toMatch(/# Babel Relay confirmatory analysis/);
    expect(first).toMatch(/Experiment verdict: \*\*CONFIRMED\*\*/);
    expect(first).toMatch(/H1 Addressing detects drift/);
    expect(first).toMatch(/PASS/);
  });
});
