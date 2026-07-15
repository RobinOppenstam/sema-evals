import { describe, expect, it } from "vitest";

import {
  buildSizeReuseConditions,
  parseSizeReuseCondition,
  sizeReuseConditionId,
  sizeReuseDeliveryPolicy,
} from "../../src/size-reuse/conditions.js";
import {
  SEMA_TAX_REUSE_FACTORS,
  SEMA_TAX_SIZE_REUSE_DELIVERIES,
  SEMA_TAX_SIZE_REUSE_PATTERN_COUNT,
  SEMA_TAX_SIZE_TIERS,
} from "../../src/size-reuse/schemas.js";

describe("buildSizeReuseConditions", () => {
  it("enumerates the full 3 x 3 x 3 grid at p8 cold", () => {
    const conditions = buildSizeReuseConditions();
    expect(conditions).toHaveLength(27);
    expect(new Set(conditions).size).toBe(conditions.length);
    for (const id of conditions) {
      const parts = parseSizeReuseCondition(id);
      expect(parts.patternCount).toBe(SEMA_TAX_SIZE_REUSE_PATTERN_COUNT);
      expect(id.endsWith("-cold")).toBe(true);
    }
  });

  it("covers every size x reuse x delivery combination exactly once", () => {
    const conditions = new Set(buildSizeReuseConditions());
    for (const size of SEMA_TAX_SIZE_TIERS) {
      for (const reuse of SEMA_TAX_REUSE_FACTORS) {
        for (const delivery of SEMA_TAX_SIZE_REUSE_DELIVERIES) {
          expect(conditions.has(`p8-${size}-r${reuse}-${delivery}-cold`)).toBe(
            true,
          );
        }
      }
    }
  });

  it("is stably ordered (size, then reuse, then delivery)", () => {
    const conditions = buildSizeReuseConditions();
    expect(conditions[0]).toBe("p8-small-r1-prose-cold");
    expect(conditions.at(-1)).toBe("p8-large-r9-content-cold");
  });
});

describe("parseSizeReuseCondition and sizeReuseConditionId", () => {
  it("round-trips every built condition", () => {
    for (const id of buildSizeReuseConditions()) {
      expect(sizeReuseConditionId(parseSizeReuseCondition(id))).toBe(id);
    }
  });

  it("decomposes a crossed condition", () => {
    expect(parseSizeReuseCondition("p8-medium-r3-content-cold")).toEqual({
      patternCount: 8,
      size: "medium",
      reuse: 3,
      delivery: "content",
    });
  });

  it("throws on a malformed or base-arm id", () => {
    expect(() => parseSizeReuseCondition("p8-content-cold")).toThrow(
      /Malformed/,
    );
    expect(() => parseSizeReuseCondition("p8-medium-content-cold")).toThrow(
      /Malformed/,
    );
    expect(() => parseSizeReuseCondition("p8-medium-r3-content-warm")).toThrow(
      /Malformed/,
    );
  });
});

describe("sizeReuseDeliveryPolicy", () => {
  it("keeps prose inline and hydration-free but hydrates both resolver arms", () => {
    expect(sizeReuseDeliveryPolicy("prose").hydratesFromRegistry).toBe(false);
    expect(sizeReuseDeliveryPolicy("opaque").hydratesFromRegistry).toBe(true);
    expect(sizeReuseDeliveryPolicy("content").hydratesFromRegistry).toBe(true);
  });
});
