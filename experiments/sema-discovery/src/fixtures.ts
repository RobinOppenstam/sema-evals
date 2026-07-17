import { readFile } from "node:fs/promises";

import { fingerprint, sha256Text } from "@sema-evals/core";
import { parse } from "yaml";

import { rankPatterns } from "./search.js";
import {
  discoveryFixtureSetSchema,
  type DiscoveryFixtureSet,
} from "./schemas.js";

export async function loadDiscoveryFixtures(path: string): Promise<{
  fixtureSet: DiscoveryFixtureSet;
  fixtureDigest: string;
  catalogFingerprint: string;
}> {
  const raw = await readFile(path, "utf8");
  const fixtureSet = discoveryFixtureSetSchema.parse(parse(raw));
  const handles = new Set(fixtureSet.catalog.map((pattern) => pattern.handle));
  if (handles.size !== fixtureSet.catalog.length) {
    throw new Error("Discovery catalog handles must be unique.");
  }
  for (const scenario of fixtureSet.scenarios) {
    if (!handles.has(scenario.correctHandle)) {
      throw new Error(
        `${scenario.id}: correct handle ${scenario.correctHandle} is missing.`,
      );
    }
    if (fixtureSet.catalog.length - 1 < 2) {
      throw new Error(`${scenario.id}: at least two distractors are required.`);
    }
    for (const task of scenario.tasks) {
      const ranked = rankPatterns(task.request, fixtureSet.catalog);
      if (ranked[0]?.handle !== scenario.correctHandle) {
        throw new Error(
          `${scenario.id}/${task.id}: frozen ranker does not select ${scenario.correctHandle}.`,
        );
      }
    }
  }
  return {
    fixtureSet,
    fixtureDigest: sha256Text(raw),
    catalogFingerprint: fingerprint(fixtureSet.catalog),
  };
}
