import { describe, expect, it } from "vitest";

import {
  aggregateTrials,
  classifyOutcome,
  compareWithSummary,
  type ConditionAggregate,
  type SummaryLike,
} from "../lib/aggregate.js";
import { makeTrial } from "./fixtures.js";

function syntheticRecords() {
  return [
    // equal-prose, drift scenario s1
    makeTrial({
      scenarioId: "s1",
      condition: "equal-prose",
      seed: 0,
      metrics: {
        driftInjected: true,
        silentDivergence: true,
        taskSuccess: false,
      },
    }),
    makeTrial({
      scenarioId: "s1",
      condition: "equal-prose",
      seed: 1,
      metrics: {
        driftInjected: true,
        driftDetected: true,
        halted: true,
        correctHalt: true,
        taskSuccess: false,
      },
    }),
    // equal-prose, control scenario s2
    makeTrial({
      scenarioId: "s2",
      condition: "equal-prose",
      seed: 0,
      metrics: { driftInjected: false, taskSuccess: true },
    }),
    // addressed-enforced, drift scenario s1
    makeTrial({
      scenarioId: "s1",
      condition: "addressed-enforced",
      seed: 0,
      metrics: {
        driftInjected: true,
        driftDetected: true,
        halted: true,
        correctHalt: true,
        taskSuccess: true,
      },
    }),
    // addressed-enforced, control scenario s2 with a false halt
    makeTrial({
      scenarioId: "s2",
      condition: "addressed-enforced",
      seed: 0,
      metrics: {
        driftInjected: false,
        halted: true,
        falseHalt: true,
        taskSuccess: false,
      },
    }),
  ];
}

function condition(
  aggregate: ReturnType<typeof aggregateTrials>,
  name: string,
): ConditionAggregate {
  const found = aggregate.conditions.find((c) => c.condition === name);
  if (found === undefined) {
    throw new Error(`condition ${name} not found`);
  }
  return found;
}

describe("classifyOutcome", () => {
  it("ranks silent divergence above every other outcome", () => {
    const record = makeTrial({
      scenarioId: "s1",
      condition: "baseline",
      seed: 0,
      metrics: {
        driftInjected: true,
        silentDivergence: true,
        taskSuccess: true,
      },
    });
    expect(classifyOutcome(record)).toBe("silent-divergence");
  });

  it("distinguishes correct and false halts", () => {
    const correct = makeTrial({
      scenarioId: "s1",
      condition: "baseline",
      seed: 0,
      metrics: { halted: true, correctHalt: true },
    });
    const wrong = makeTrial({
      scenarioId: "s1",
      condition: "baseline",
      seed: 0,
      metrics: { halted: true, falseHalt: true },
    });
    expect(classifyOutcome(correct)).toBe("correct-halt");
    expect(classifyOutcome(wrong)).toBe("false-halt");
  });
});

describe("aggregateTrials", () => {
  const aggregate = aggregateTrials(syntheticRecords());

  it("counts trials and scenarios", () => {
    expect(aggregate.trialCount).toBe(5);
    expect(aggregate.scenarioCount).toBe(2);
    expect(aggregate.scenarioIds).toEqual(["s1", "s2"]);
  });

  it("computes equal-prose counts and rates over the right denominators", () => {
    const c = condition(aggregate, "equal-prose");
    expect(c.trials).toBe(3);
    expect(c.driftTrials).toBe(2);
    expect(c.detected).toBe(1);
    expect(c.silentDivergences).toBe(1);
    expect(c.correctHalts).toBe(1);
    expect(c.taskSuccesses).toBe(1);
    expect(c.silentDivergenceRate).toBeCloseTo(0.5);
    expect(c.taskSuccessRate).toBeCloseTo(1 / 3);
  });

  it("computes addressed-enforced counts including false halts", () => {
    const c = condition(aggregate, "addressed-enforced");
    expect(c.trials).toBe(2);
    expect(c.driftTrials).toBe(1);
    expect(c.silentDivergences).toBe(0);
    expect(c.correctHalts).toBe(1);
    expect(c.falseHalts).toBe(1);
    expect(c.taskSuccesses).toBe(1);
    expect(c.silentDivergenceRate).toBe(0);
    expect(c.taskSuccessRate).toBeCloseTo(0.5);
  });

  it("orders conditions canonically and builds a scenario grid", () => {
    expect(aggregate.conditions.map((c) => c.condition)).toEqual([
      "equal-prose",
      "addressed-enforced",
    ]);
    const cell = aggregate.grid.find(
      (g) => g.scenarioId === "s1" && g.condition === "equal-prose",
    );
    expect(cell?.outcomes).toEqual(["silent-divergence", "correct-halt"]);
  });
});

describe("compareWithSummary", () => {
  const aggregate = aggregateTrials(syntheticRecords());

  function summaryFromAggregate(): SummaryLike {
    return {
      trialCount: aggregate.trialCount,
      scenarioCount: aggregate.scenarioCount,
      conditions: aggregate.conditions.map((c) => ({
        condition: c.condition,
        trials: c.trials,
        driftTrials: c.driftTrials,
        detected: c.detected,
        halted: c.halted,
        silentDivergences: c.silentDivergences,
        taskSuccesses: c.taskSuccesses,
        falseHalts: c.falseHalts,
        silentDivergenceRate: c.silentDivergenceRate,
        taskSuccessRate: c.taskSuccessRate,
      })),
    };
  }

  it("returns no warnings when the summary agrees", () => {
    expect(compareWithSummary(aggregate, summaryFromAggregate())).toEqual([]);
  });

  it("flags a mismatched count", () => {
    const summary = summaryFromAggregate();
    summary.conditions![0]!.silentDivergences = 99;
    const warnings = compareWithSummary(aggregate, summary);
    expect(warnings.some((w) => w.includes("silentDivergences"))).toBe(true);
    expect(warnings.some((w) => w.includes("summary=99"))).toBe(true);
  });

  it("flags a mismatched rate beyond epsilon", () => {
    const summary = summaryFromAggregate();
    summary.conditions![0]!.silentDivergenceRate = 0.123;
    const warnings = compareWithSummary(aggregate, summary);
    expect(warnings.some((w) => w.includes("silentDivergenceRate"))).toBe(true);
  });

  it("flags a totals mismatch and a missing condition", () => {
    const summary: SummaryLike = { trialCount: 4, conditions: [] };
    const warnings = compareWithSummary(aggregate, summary);
    expect(warnings.some((w) => w.startsWith("trialCount:"))).toBe(true);
    expect(warnings.some((w) => w.includes("missing from summary.json"))).toBe(
      true,
    );
  });

  it("tolerates a summary missing optional fields", () => {
    expect(compareWithSummary(aggregate, {})).toEqual([]);
  });
});
