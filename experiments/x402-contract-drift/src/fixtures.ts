import { readFile } from "node:fs/promises";

import { sha256Text } from "@sema-evals/core";
import { parse } from "yaml";

import { assertDriftIsolation } from "./registry.js";
import {
  x402DriftFixtureSetSchema,
  type X402DriftFixtureSet,
} from "./schemas.js";

export interface LoadedX402Fixtures {
  fixtureDigest: string;
  fixtureSet: X402DriftFixtureSet;
  driftScenarioCount: number;
  cleanScenarioCount: number;
}

/**
 * Loads and validates the x402 drift fixtures. Beyond schema validation this
 * enforces cross-references the demo depends on — unique scenario ids, and the
 * drift-isolation guarantee (the payer registry differs from the seller's on
 * exactly the drifted handle, or nowhere for a no-drift control). A digest of
 * the raw file goes into the manifest for provenance.
 */
export async function loadFixtureFile(
  path: string,
): Promise<LoadedX402Fixtures> {
  const raw = await readFile(path, "utf8");
  const fixtureSet = x402DriftFixtureSetSchema.parse(parse(raw));

  const scenarioIds = new Set<string>();
  let driftScenarioCount = 0;
  for (const scenario of fixtureSet.scenarios) {
    if (scenarioIds.has(scenario.id)) {
      throw new Error(`Duplicate scenario id: ${scenario.id}.`);
    }
    scenarioIds.add(scenario.id);
    assertDriftIsolation(scenario);
    if (scenario.drift !== null) {
      driftScenarioCount += 1;
    }
  }

  return {
    fixtureDigest: sha256Text(raw),
    fixtureSet,
    driftScenarioCount,
    cleanScenarioCount: fixtureSet.scenarios.length - driftScenarioCount,
  };
}
