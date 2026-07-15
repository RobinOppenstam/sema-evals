import { readFile } from "node:fs/promises";

import { sha256Text } from "@sema-evals/core";
import { parse } from "yaml";

import { SEMA_TAX_PATTERN_COUNTS } from "./conditions.js";
import {
  semaTaxFixtureSetSchema,
  type SemaTaxFixtureSet,
  type SemaTaxPattern,
} from "./schemas.js";

export interface LoadedFixtures {
  fixtureDigest: string;
  fixtureSet: SemaTaxFixtureSet;
  patternsByHandle: Map<string, SemaTaxPattern>;
}

const MAX_PATTERN_COUNT = Math.max(...SEMA_TAX_PATTERN_COUNTS);

/**
 * Loads and validates the worksheet fixtures. Beyond schema validation this
 * enforces the cross-references the tax curve depends on: every pool and item
 * handle resolves to a defined pattern, handles are unique, and each scenario's
 * pool is deep enough to support the largest studied pattern count. A digest of
 * the raw file goes into the manifest for provenance.
 */
export async function loadFixtureFile(path: string): Promise<LoadedFixtures> {
  const raw = await readFile(path, "utf8");
  const fixtureSet = semaTaxFixtureSetSchema.parse(parse(raw));

  const patternsByHandle = new Map<string, SemaTaxPattern>();
  for (const pattern of fixtureSet.patterns) {
    if (patternsByHandle.has(pattern.handle)) {
      throw new Error(`Duplicate pattern handle: ${pattern.handle}.`);
    }
    patternsByHandle.set(pattern.handle, pattern);
  }

  const scenarioIds = new Set<string>();
  for (const scenario of fixtureSet.scenarios) {
    if (scenarioIds.has(scenario.id)) {
      throw new Error(`Duplicate scenario id: ${scenario.id}.`);
    }
    scenarioIds.add(scenario.id);

    if (scenario.patternPool.length < MAX_PATTERN_COUNT) {
      throw new Error(
        `Scenario ${scenario.id} pool has ${scenario.patternPool.length} patterns; needs at least ${MAX_PATTERN_COUNT}.`,
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
