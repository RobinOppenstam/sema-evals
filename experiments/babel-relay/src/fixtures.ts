import { readFile } from "node:fs/promises";

import {
  fingerprint,
  relayScenarioSetSchema,
  sha256Text,
} from "@sema-evals/core";
import { parse } from "yaml";

export async function loadScenarioFile(path: string) {
  const raw = await readFile(path, "utf8");
  const scenarioSet = relayScenarioSetSchema.parse(parse(raw));

  for (const scenario of scenarioSet.scenarios) {
    const definitionsMatch =
      fingerprint(scenario.contract.canonicalDefinition) ===
      fingerprint(scenario.contract.mutatedDefinition);
    if (scenario.mutation === null && !definitionsMatch) {
      throw new Error(
        `${scenario.id}: no-drift fixture contains different definitions.`,
      );
    }
    if (scenario.mutation !== null && definitionsMatch) {
      throw new Error(
        `${scenario.id}: drift fixture contains identical definitions.`,
      );
    }
  }

  return {
    fixtureDigest: sha256Text(raw),
    scenarioSet,
  };
}
