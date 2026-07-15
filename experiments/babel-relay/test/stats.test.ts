import { describe, expect, it } from "vitest";

import {
  clopperPearsonInterval,
  newcombeDifferenceInterval,
  regularizedIncompleteBeta,
  wilsonInterval,
} from "../src/stats.js";

describe("wilsonInterval", () => {
  // Published 95% Wilson bounds: 0/120 -> [0, 0.0310], 108/120 -> [0.8333, 0.9419].
  it("matches the published bound for 0/120", () => {
    const { lower, upper } = wilsonInterval(0, 120);
    expect(lower).toBe(0);
    expect(upper).toBeCloseTo(0.031019, 4);
  });

  it("matches the published bounds for 108/120", () => {
    const { lower, upper } = wilsonInterval(108, 120);
    expect(lower).toBeCloseTo(0.833318, 4);
    expect(upper).toBeCloseTo(0.941866, 4);
  });

  it("clamps to [0, 1] and centers at 0.5 for a symmetric sample", () => {
    const { lower, upper } = wilsonInterval(10, 20);
    expect((lower + upper) / 2).toBeCloseTo(0.5, 10);
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(upper).toBeLessThanOrEqual(1);
  });
});

describe("regularizedIncompleteBeta", () => {
  it("is 0 at x=0 and 1 at x=1", () => {
    expect(regularizedIncompleteBeta(2, 5, 0)).toBe(0);
    expect(regularizedIncompleteBeta(2, 5, 1)).toBe(1);
  });

  it("equals x for I_x(1, 1) (the uniform CDF)", () => {
    expect(regularizedIncompleteBeta(1, 1, 0.37)).toBeCloseTo(0.37, 10);
  });
});

describe("clopperPearsonInterval", () => {
  // The preregistration's own reference: CP upper for 0/120 is ~0.0303, at or
  // below the H1 threshold of 0.05.
  it("matches the prereg reference for 0/120", () => {
    const { lower, upper } = clopperPearsonInterval(0, 120);
    expect(lower).toBe(0);
    expect(upper).toBeCloseTo(0.030273, 4);
    expect(upper).toBeLessThanOrEqual(0.05);
  });

  it("gives a full [0, 1] span only at the extremes", () => {
    expect(clopperPearsonInterval(120, 120).upper).toBe(1);
    expect(clopperPearsonInterval(0, 120).lower).toBe(0);
  });

  it("computes an interior interval for 2/120", () => {
    const { lower, upper } = clopperPearsonInterval(2, 120);
    expect(lower).toBeCloseTo(0.002025, 4);
    expect(upper).toBeCloseTo(0.058909, 4);
    // Two silent divergences already breach the 5% H1 ceiling.
    expect(upper).toBeGreaterThan(0.05);
  });
});

describe("newcombeDifferenceInterval", () => {
  // Hand-verified against the square-and-add composition of the two Wilson
  // intervals (each anchored above): 15/20 (0.75) vs 5/20 (0.25).
  it("computes the difference interval for 15/20 vs 5/20", () => {
    const { lower, upper } = newcombeDifferenceInterval(15, 20, 5, 20);
    expect(lower).toBeCloseTo(0.19071, 4);
    expect(upper).toBeCloseTo(0.695357, 4);
  });

  it("clamps the upper bound at 1 for a saturated group", () => {
    const { lower, upper } = newcombeDifferenceInterval(10, 10, 0, 20);
    expect(upper).toBe(1);
    expect(lower).toBeCloseTo(0.679086, 4);
  });

  it("is symmetric under swapping and negating the groups", () => {
    const forward = newcombeDifferenceInterval(170, 180, 110, 180);
    const reverse = newcombeDifferenceInterval(110, 180, 170, 180);
    expect(forward.lower).toBeCloseTo(-reverse.upper, 10);
    expect(forward.upper).toBeCloseTo(-reverse.lower, 10);
  });
});
