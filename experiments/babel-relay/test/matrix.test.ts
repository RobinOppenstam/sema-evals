import { describe, expect, it } from "vitest";

import {
  EXPERIMENT_CONDITIONS,
  planPairedMatrix,
  type RelayScenario,
} from "@sema-evals/core";

function scenario(id: string): RelayScenario {
  return {
    id,
    title: id,
    description: id,
    contract: {
      handle: "TestContract",
      opaqueRef: `opaque:${id}`,
      canonicalDefinition: { invariant: "canonical" },
      mutatedDefinition: { invariant: "mutated" },
    },
    mutation: {
      boundary: "spec-to-plan",
      fieldPath: "invariant",
      before: "canonical",
      after: "mutated",
    },
    expectedAction: "halt",
  };
}

describe("paired matrix planning", () => {
  it("places every condition in every scenario/seed block", () => {
    const scenarios = [scenario("alpha"), scenario("beta")];
    const plan = planPairedMatrix({
      experimentId: "test",
      protocolVersion: "0.1.0",
      scenarios,
      scenarioId: (entry) => entry.id,
      conditions: EXPERIMENT_CONDITIONS,
      seeds: [0, 1],
      orderSeed: 42,
    });

    expect(plan).toHaveLength(20);
    for (const entry of scenarios) {
      for (const seed of [0, 1]) {
        const conditions = plan
          .filter((cell) => cell.scenarioId === entry.id && cell.seed === seed)
          .map((cell) => cell.condition)
          .sort();
        expect(conditions).toEqual([...EXPERIMENT_CONDITIONS].sort());
      }
    }
  });

  it("is reproducible for the same order seed", () => {
    const options = {
      experimentId: "test",
      protocolVersion: "0.1.0",
      scenarios: [scenario("alpha"), scenario("beta")],
      scenarioId: (entry: RelayScenario) => entry.id,
      conditions: EXPERIMENT_CONDITIONS,
      seeds: [0, 1],
      orderSeed: 7,
    };

    expect(planPairedMatrix(options)).toEqual(planPairedMatrix(options));
  });
});
