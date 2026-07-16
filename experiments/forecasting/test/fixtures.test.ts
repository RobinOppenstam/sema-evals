import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadFixtureFile } from "../src/fixtures.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/scenarios.yaml",
);

/** Markers that must never appear in agent-facing fixture text. */
const GROUND_TRUTH_MARKERS = [
  "DRIFT:",
  "GROUND_TRUTH",
  "mutatedDefinition",
  "fieldPath:",
  "before:",
  "after:",
  "EXPECT_EXCLUDE",
  "CORRUPTED_AGGREGATION",
  "SILENT_PAYMENT",
];

describe("fixture integrity", () => {
  it("loads paired drift/clean synthetic scenarios covering both drift families", async () => {
    const { fixtureSet, driftScenarioCount, cleanScenarioCount } =
      await loadFixtureFile(FIXTURE_PATH);
    expect(fixtureSet.scenarios.length).toBeGreaterThanOrEqual(6);
    expect(driftScenarioCount).toBe(cleanScenarioCount);
    expect(driftScenarioCount).toBeGreaterThanOrEqual(3);

    const ids = new Set(fixtureSet.scenarios.map((s) => s.id));
    expect(ids.has("synthetic-prob-format-drift")).toBe(true);
    expect(ids.has("synthetic-prob-format-clean")).toBe(true);
    expect(ids.has("synthetic-resolution-announced-drift")).toBe(true);

    const driftHandles = new Set(
      fixtureSet.scenarios
        .filter((s) => s.drift !== null)
        .map((s) => s.drift!.handle),
    );
    expect(driftHandles.has("ProbabilityFormat")).toBe(true);
    expect(driftHandles.has("ResolutionDefinition")).toBe(true);

    for (const scenario of fixtureSet.scenarios) {
      expect(scenario.id.startsWith("synthetic-")).toBe(true);
      expect(scenario.question.evidencePack).toBeNull();
      expect(scenario.agents.length).toBe(5);
      expect(scenario.leakageAudit.verdict).toBe("keep");
    }
  });

  it("keeps agent-facing fixture text free of ground-truth annotations", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    for (const scenario of fixtureSet.scenarios) {
      const agentFacing = [
        scenario.question.questionText,
        scenario.question.resolutionCriteria,
        ...scenario.patterns.map((pattern) =>
          String(pattern.definition["gloss"] ?? ""),
        ),
      ].join("\n");
      for (const marker of GROUND_TRUTH_MARKERS) {
        expect(
          agentFacing.includes(marker),
          `${scenario.id} agent-facing text contains "${marker}"`,
        ).toBe(false);
      }
      if (scenario.drift) {
        expect(agentFacing).not.toContain(String(scenario.drift.before));
        expect(agentFacing).not.toContain(String(scenario.drift.after));
      }
    }
  });
});
