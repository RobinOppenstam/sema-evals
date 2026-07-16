import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import { describe, expect, it } from "vitest";

import {
  aggregateForecasts,
  normalizeProbability,
} from "../src/aggregation.js";
import { buildForecastObject } from "../src/agents.js";
import { loadFixtureFile } from "../src/fixtures.js";
import {
  buildAgentRegistry,
  buildCanonicalRegistry,
  type AgentRegistry,
} from "../src/registry.js";
import { SEMANTIC_MISMATCH_REASON } from "../src/schemas.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/scenarios.yaml",
);

describe("probability-format garbage average", () => {
  it("baseline averages 0.55+0.60+0.65+0.58+62 into exactly 12.876", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const scenario = fixtureSet.scenarios.find(
      (entry) => entry.id === "synthetic-prob-format-drift",
    );
    if (!scenario) {
      throw new Error("Expected synthetic-prob-format-drift.");
    }

    const provider = new FixtureReferenceProvider();
    const registries = new Map<string, AgentRegistry>();
    const forecasts = [];
    for (const agent of scenario.agents) {
      const registry = buildAgentRegistry(scenario, agent.id);
      registries.set(agent.id, registry);
      forecasts.push(
        await buildForecastObject({
          scenario,
          agentId: agent.id,
          round: 2,
          probability: agent.round2Probability,
          condition: "baseline",
          registry,
          referenceProvider: provider,
        }),
      );
    }

    const result = await aggregateForecasts({
      forecasts,
      condition: "baseline",
      canonicalRegistry: buildCanonicalRegistry(scenario),
      agentRegistries: registries,
      referenceProvider: provider,
    });

    expect(forecasts.map((f) => f.probability)).toEqual([
      0.55, 0.6, 0.65, 0.58, 62,
    ]);
    expect(result.aggregateProbability).toBeCloseTo(12.876, 10);
    expect(result.driftDetected).toBe(false);
    expect(result.included).toHaveLength(5);
    expect(result.excluded).toHaveLength(0);
  });

  it("addressed-voluntary surfaces the mismatch but still aggregates all after normalization", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const scenario = fixtureSet.scenarios.find(
      (entry) => entry.id === "synthetic-prob-format-drift",
    );
    if (!scenario) {
      throw new Error("Expected synthetic-prob-format-drift.");
    }

    const provider = new FixtureReferenceProvider();
    const registries = new Map<string, AgentRegistry>();
    const forecasts = [];
    for (const agent of scenario.agents) {
      const registry = buildAgentRegistry(scenario, agent.id);
      registries.set(agent.id, registry);
      forecasts.push(
        await buildForecastObject({
          scenario,
          agentId: agent.id,
          round: 2,
          probability: agent.round2Probability,
          condition: "addressed-voluntary",
          registry,
          referenceProvider: provider,
        }),
      );
    }

    const result = await aggregateForecasts({
      forecasts,
      condition: "addressed-voluntary",
      canonicalRegistry: buildCanonicalRegistry(scenario),
      agentRegistries: registries,
      referenceProvider: provider,
    });

    expect(result.driftDetected).toBe(true);
    expect(result.included).toHaveLength(5);
    expect(result.excluded).toHaveLength(0);
    // Normalized: (0.55+0.60+0.65+0.58+0.62)/5 = 0.6
    expect(result.aggregateProbability).toBeCloseTo(0.6, 10);
  });

  it("addressed-enforced excludes the drifted forecast with a typed reason", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const scenario = fixtureSet.scenarios.find(
      (entry) => entry.id === "synthetic-prob-format-drift",
    );
    if (!scenario) {
      throw new Error("Expected synthetic-prob-format-drift.");
    }

    const provider = new FixtureReferenceProvider();
    const registries = new Map<string, AgentRegistry>();
    const forecasts = [];
    for (const agent of scenario.agents) {
      const registry = buildAgentRegistry(scenario, agent.id);
      registries.set(agent.id, registry);
      forecasts.push(
        await buildForecastObject({
          scenario,
          agentId: agent.id,
          round: 2,
          probability: agent.round2Probability,
          condition: "addressed-enforced",
          registry,
          referenceProvider: provider,
        }),
      );
    }

    const result = await aggregateForecasts({
      forecasts,
      condition: "addressed-enforced",
      canonicalRegistry: buildCanonicalRegistry(scenario),
      agentRegistries: registries,
      referenceProvider: provider,
    });

    expect(result.driftDetected).toBe(true);
    expect(result.excluded.map((f) => f.agentId)).toEqual(["forecaster-4"]);
    expect(result.exclusionReasons.get("forecaster-4")).toBe(
      SEMANTIC_MISMATCH_REASON,
    );
    expect(result.included).toHaveLength(4);
    // (0.55+0.60+0.65+0.58)/4 = 0.595
    expect(result.aggregateProbability).toBeCloseTo(0.595, 10);
  });
});

describe("normalizeProbability", () => {
  it("passes unit-scale values through and divides percent-scale by 100", () => {
    expect(normalizeProbability(0.62, { scale: "unit" })).toBe(0.62);
    expect(normalizeProbability(62, { scale: "percent" })).toBe(0.62);
  });
});
