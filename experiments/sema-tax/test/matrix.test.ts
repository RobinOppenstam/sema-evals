import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION, planPairedMatrix } from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import { buildConditions } from "../src/conditions.js";
import { loadFixtureFile } from "../src/fixtures.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/worksheets.yaml",
);

describe("sema-tax paired matrix", () => {
  it("places every condition in every scenario/seed block", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const conditions = buildConditions();
    const seeds = [0, 1];
    const plan = planPairedMatrix({
      experimentId: "sema-tax",
      protocolVersion: PROTOCOL_VERSION,
      scenarios: fixtureSet.scenarios,
      scenarioId: (scenario) => scenario.id,
      conditions,
      seeds,
      orderSeed: 20_260_714,
    });

    expect(plan).toHaveLength(
      fixtureSet.scenarios.length * conditions.length * seeds.length,
    );

    const expected = [...conditions].sort();
    for (const scenario of fixtureSet.scenarios) {
      for (const seed of seeds) {
        const seen = plan
          .filter(
            (cell) => cell.scenarioId === scenario.id && cell.seed === seed,
          )
          .map((cell) => cell.condition)
          .sort();
        expect(seen).toEqual(expected);
      }
    }
  });

  it("is reproducible for the same order seed", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const options = {
      experimentId: "sema-tax",
      protocolVersion: PROTOCOL_VERSION,
      scenarios: fixtureSet.scenarios,
      scenarioId: (scenario: (typeof fixtureSet.scenarios)[number]) =>
        scenario.id,
      conditions: buildConditions(),
      seeds: [0, 1],
      orderSeed: 7,
    };
    expect(planPairedMatrix(options)).toEqual(planPairedMatrix(options));
  });

  it("keeps the fixture directory resolvable", () => {
    expect(join(FIXTURE_PATH, "..")).toContain("fixtures");
  });
});
