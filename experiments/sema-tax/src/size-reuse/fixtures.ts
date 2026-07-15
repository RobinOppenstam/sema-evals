import { readFile } from "node:fs/promises";

import { sha256Text } from "@sema-evals/core";
import { parse } from "yaml";

import { tierDefinitionBytes } from "./context.js";
import {
  SEMA_TAX_SIZE_REUSE_PATTERN_COUNT,
  SEMA_TAX_TIER_BYTE_BANDS,
  semaTaxSizeReuseFixtureSetSchema,
  type SemaTaxSizeReuseFixtureSet,
  type SemaTaxSizedPattern,
} from "./schemas.js";

export interface LoadedSizeReuseFixtures {
  fixtureDigest: string;
  fixtureSet: SemaTaxSizeReuseFixtureSet;
  patternsByHandle: Map<string, SemaTaxSizedPattern>;
}

/**
 * Loads and validates the size/reuse worksheet fixtures. Beyond schema
 * validation and the base cross-reference checks, this enforces the two
 * invariants the arm depends on:
 *
 * 1. **Byte-band enforcement.** Every pattern's medium and large rendered
 *    definition falls inside the canonical byte band (medium 900-1200, large
 *    3500-4500), so the size axis really does vary bytes by roughly an order of
 *    magnitude while difficulty is held constant.
 * 2. **Core identity across tiers.** The scoreable core (comparator, threshold,
 *    unit, gloss) is byte-identical across small/medium/large — auxiliary content
 *    is strictly additive and never perturbs ground truth.
 *
 * These are enforced at load so a malformed fixture fails fast, and are also
 * asserted directly by the fixture test.
 */
export async function loadSizeReuseFixtureFile(
  path: string,
): Promise<LoadedSizeReuseFixtures> {
  const raw = await readFile(path, "utf8");
  const fixtureSet = semaTaxSizeReuseFixtureSetSchema.parse(parse(raw));

  const patternsByHandle = new Map<string, SemaTaxSizedPattern>();
  for (const pattern of fixtureSet.patterns) {
    if (patternsByHandle.has(pattern.handle)) {
      throw new Error(`Duplicate pattern handle: ${pattern.handle}.`);
    }
    patternsByHandle.set(pattern.handle, pattern);
    enforceByteBands(pattern);
  }

  const scenarioIds = new Set<string>();
  for (const scenario of fixtureSet.scenarios) {
    if (scenarioIds.has(scenario.id)) {
      throw new Error(`Duplicate scenario id: ${scenario.id}.`);
    }
    scenarioIds.add(scenario.id);

    if (scenario.patternPool.length < SEMA_TAX_SIZE_REUSE_PATTERN_COUNT) {
      throw new Error(
        `Scenario ${scenario.id} pool has ${scenario.patternPool.length} patterns; needs at least ${SEMA_TAX_SIZE_REUSE_PATTERN_COUNT}.`,
      );
    }
    const poolSet = new Set(scenario.patternPool);
    if (poolSet.size !== scenario.patternPool.length) {
      throw new Error(`Scenario ${scenario.id} pool contains duplicates.`);
    }
    for (const handle of scenario.patternPool) {
      if (!patternsByHandle.has(handle)) {
        throw new Error(
          `Scenario ${scenario.id} pool references unknown pattern ${handle}.`,
        );
      }
    }

    const itemIds = new Set<string>();
    for (const item of scenario.items) {
      if (itemIds.has(item.id)) {
        throw new Error(
          `Scenario ${scenario.id} has duplicate item id ${item.id}.`,
        );
      }
      itemIds.add(item.id);
      if (!patternsByHandle.has(item.patternHandle)) {
        throw new Error(
          `Scenario ${scenario.id} item ${item.id} references unknown pattern ${item.patternHandle}.`,
        );
      }
      if (!poolSet.has(item.patternHandle)) {
        throw new Error(
          `Scenario ${scenario.id} item ${item.id} references pattern ${item.patternHandle} that is not in the scenario pool.`,
        );
      }
    }
  }

  return {
    fixtureDigest: sha256Text(raw),
    fixtureSet,
    patternsByHandle,
  };
}

/** Throws unless every non-small tier of the pattern lands in its byte band. */
export function enforceByteBands(pattern: SemaTaxSizedPattern): void {
  for (const tier of ["medium", "large"] as const) {
    const bytes = tierDefinitionBytes(pattern, tier);
    const band = SEMA_TAX_TIER_BYTE_BANDS[tier];
    if (bytes < band.min || bytes > band.max) {
      throw new Error(
        `Pattern ${pattern.handle} ${tier} definition is ${bytes} B, outside the canonical band [${band.min}, ${band.max}].`,
      );
    }
  }
}
