import { describe, expect, it } from "vitest";

import {
  SEMA_TAX_CACHE_STATES,
  SEMA_TAX_DELIVERIES,
  SEMA_TAX_PATTERN_COUNTS,
  buildConditions,
  conditionId,
  deliveryPolicy,
  parseCondition,
} from "../src/conditions.js";

describe("buildConditions", () => {
  it("enumerates the anchor plus the full crossing", () => {
    const conditions = buildConditions();
    // 1 baseline anchor + 5 counts x 3 deliveries x 2 caches = 31.
    expect(conditions).toHaveLength(31);
    expect(conditions[0]).toBe("p0-baseline");
    expect(new Set(conditions).size).toBe(conditions.length);
  });

  it("only emits the baseline once for the zero-pattern level", () => {
    const zero = buildConditions().filter((id) => id.startsWith("p0-"));
    expect(zero).toEqual(["p0-baseline"]);
  });

  it("covers every non-zero count x delivery x cache combination", () => {
    const conditions = new Set(buildConditions());
    for (const count of SEMA_TAX_PATTERN_COUNTS) {
      if (count === 0) {
        continue;
      }
      for (const delivery of SEMA_TAX_DELIVERIES) {
        for (const cache of SEMA_TAX_CACHE_STATES) {
          expect(conditions.has(`p${count}-${delivery}-${cache}`)).toBe(true);
        }
      }
    }
  });
});

describe("parseCondition and conditionId", () => {
  it("round-trips every built condition", () => {
    for (const id of buildConditions()) {
      expect(conditionId(parseCondition(id))).toBe(id);
    }
  });

  it("decomposes the baseline anchor", () => {
    expect(parseCondition("p0-baseline")).toEqual({
      patternCount: 0,
      delivery: "baseline",
      cacheState: "none",
    });
  });

  it("decomposes a crossed condition", () => {
    expect(parseCondition("p8-content-warm")).toEqual({
      patternCount: 8,
      delivery: "content",
      cacheState: "warm",
    });
  });

  it("throws on a malformed id", () => {
    expect(() => parseCondition("p8-content")).toThrow(/Malformed/);
    expect(() => parseCondition("bogus")).toThrow(/Malformed/);
  });
});

describe("deliveryPolicy", () => {
  it("keeps prose inline and hydration-free", () => {
    const policy = deliveryPolicy("prose");
    expect(policy.onWire).toBe("inline-definitions");
    expect(policy.hydratesFromRegistry).toBe(false);
    expect(policy.referenceStyle).toBe("none");
  });

  it("hydrates both resolver arms but only content is content-derived", () => {
    expect(deliveryPolicy("opaque")).toEqual({
      onWire: "opaque-references",
      hydratesFromRegistry: true,
      referenceStyle: "opaque",
    });
    expect(deliveryPolicy("content")).toEqual({
      onWire: "content-references",
      hydratesFromRegistry: true,
      referenceStyle: "content",
    });
  });

  it("ships nothing but the task for the baseline", () => {
    expect(deliveryPolicy("baseline").onWire).toBe("task-only");
  });
});
