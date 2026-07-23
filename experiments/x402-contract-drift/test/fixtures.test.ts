import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadFixtureFile } from "../src/fixtures.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/scenarios.yaml",
);

/** Markers that must never appear in payer-facing fixture text. */
const GROUND_TRUTH_MARKERS = [
  "DRIFT:",
  "GROUND_TRUTH",
  "mutatedDefinition",
  "fieldPath:",
  "before:",
  "after:",
  "EXPECT_HALT",
  "EXPECT_REFUSE",
  "SILENT_PAYMENT",
];

const SEMA_SEMANTIC_FIELDS = new Set([
  "dependencies",
  "signature",
  "data_schema",
  "mechanism",
  "gloss",
  "invariants",
  "preconditions",
  "postconditions",
  "parameters",
  "failure_modes",
  "derived_from",
]);

describe("fixture integrity", () => {
  it("loads 10–14 scenarios over 6–8 payment-term handles with paired controls", async () => {
    const { fixtureSet, driftScenarioCount, cleanScenarioCount } =
      await loadFixtureFile(FIXTURE_PATH);
    expect(fixtureSet.scenarios.length).toBeGreaterThanOrEqual(10);
    expect(fixtureSet.scenarios.length).toBeLessThanOrEqual(14);
    expect(driftScenarioCount).toBe(cleanScenarioCount);
    expect(driftScenarioCount).toBeGreaterThanOrEqual(5);

    const handles = new Set<string>();
    for (const scenario of fixtureSet.scenarios) {
      for (const pattern of scenario.patterns) {
        handles.add(pattern.handle);
      }
    }
    expect(handles.size).toBeGreaterThanOrEqual(6);
    expect(handles.size).toBeLessThanOrEqual(8);
  });

  it("keeps payer-facing fixture text free of ground-truth annotations", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    for (const scenario of fixtureSet.scenarios) {
      const payerFacing = [
        scenario.resourceDescription,
        scenario.resource,
      ].join("\n");
      for (const marker of GROUND_TRUTH_MARKERS) {
        expect(
          payerFacing.includes(marker),
          `${scenario.id} payer-facing text contains "${marker}"`,
        ).toBe(false);
      }
      // Drift metadata must not leak into the description the payer sees on
      // the wire (resourceDescription is the seed for requirements.description).
      if (scenario.drift) {
        expect(payerFacing).not.toContain(String(scenario.drift.before));
        expect(payerFacing).not.toContain(String(scenario.drift.after));
      }
    }
  });

  it("stores every definition attribute in a field hashed by Sema", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    for (const scenario of fixtureSet.scenarios) {
      const definitions = [
        ...scenario.patterns.map((pattern) => pattern.definition),
        ...(scenario.drift ? [scenario.drift.mutatedDefinition] : []),
      ];
      for (const definition of definitions) {
        for (const field of Object.keys(definition)) {
          expect(
            SEMA_SEMANTIC_FIELDS.has(field),
            `${scenario.id} uses non-semantic top-level field ${field}`,
          ).toBe(true);
        }
      }
    }
  });
});
