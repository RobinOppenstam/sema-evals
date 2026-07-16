import { readFile } from "node:fs/promises";

import { sha256Text } from "@sema-evals/core";
import { parse } from "yaml";

import { assertDriftIsolation } from "./registry.js";
import {
  forecastingFixtureSetSchema,
  type ForecastingFixtureSet,
} from "./schemas.js";

export interface LoadedForecastingFixtures {
  fixtureDigest: string;
  fixtureSet: ForecastingFixtureSet;
  driftScenarioCount: number;
  cleanScenarioCount: number;
}

/**
 * Loads and validates the forecasting fixtures. Beyond schema validation this
 * enforces cross-references the demo depends on — unique scenario ids, and the
 * drift-isolation guarantee (exactly one agent differs on exactly the drifted
 * handle, or nowhere for a no-drift control). A digest of the raw file goes
 * into the manifest for provenance.
 */
export async function loadFixtureFile(
  path: string,
): Promise<LoadedForecastingFixtures> {
  const raw = await readFile(path, "utf8");
  const fixtureSet = forecastingFixtureSetSchema.parse(parse(raw));

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
