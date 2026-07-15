import { describe, expect, it } from "vitest";

import type { ResultManifest } from "../../packages/core/src/schemas.js";
import {
  getAdapter,
  registeredExperimentIds,
  requireAdapter,
} from "../lib/experiment-adapter.js";
import { aggregateTrials } from "../lib/aggregate.js";
import {
  renderBabelRelaySection,
  renderIndex,
  renderIndexShell,
  type RunView,
} from "../lib/render.js";
import { makeTrial } from "./fixtures.js";

const HEX64 = "a".repeat(64);

function makeBabelManifest(
  overrides: Partial<ResultManifest> = {},
): ResultManifest {
  return {
    artifactSchemaVersion: "0.3.0",
    protocolVersion: "0.3.0",
    experimentId: "babel-relay",
    // Covered by the babel-relay interpretation note, so the coverage gate is
    // satisfied for this synthetic run.
    runId: "20260714T170651223Z-order-20260714",
    mode: "model-pilot",
    evidenceClaim: "Exploratory model pilot. Not confirmatory evidence.",
    createdAt: "2026-07-14T00:00:00.000Z",
    orderSeed: 20260714,
    seeds: [0],
    conditions: ["equal-prose"],
    scenarioCount: 1,
    trialCount: 1,
    fixtureDigest: HEX64,
    provenance: {
      artifactSchemaVersion: "0.3.0",
      protocolVersion: "0.3.0",
      fixtureDigest: HEX64,
      implementationCommit: "abc123",
      dependencyLockDigest: HEX64,
      promptDigest: HEX64,
      semaVersion: "not-connected",
      canonicalizationVersion: "fixture-stable-json-v1",
      vocabularyRoot: "",
      semanticBackend: "fixture-sha256-stable-json-v1",
      modelProvider: "llm.example",
      modelName: "example/model",
    },
    ...overrides,
  };
}

function makeBabelRunView(): RunView {
  const aggregate = aggregateTrials([
    makeTrial({
      scenarioId: "s1",
      condition: "equal-prose",
      seed: 0,
      metrics: { taskSuccess: true },
    }),
  ]);
  return { manifest: makeBabelManifest(), aggregate, dataDir: "run" };
}

describe("experiment-adapter registry", () => {
  it("dispatches known experiment ids to their adapters", () => {
    expect(getAdapter("babel-relay")?.experimentId).toBe("babel-relay");
    expect(getAdapter("sema-tax")?.experimentId).toBe("sema-tax");
    expect(registeredExperimentIds()).toEqual(["babel-relay", "sema-tax"]);
  });

  it("returns undefined / throws for an unregistered experiment", () => {
    expect(getAdapter("mystery")).toBeUndefined();
    expect(() => requireAdapter("mystery")).toThrow(
      /No site adapter registered for experiment "mystery"/,
    );
  });
});

describe("babel-relay index rendering is unchanged by the refactor", () => {
  it("renderIndex equals the shell composed from the babel section", () => {
    const run = makeBabelRunView();
    // The adapter path builds the index as shell([section, ...]); the retained
    // renderIndex must produce byte-identical HTML for the same babel runs.
    expect(renderIndex([run])).toEqual(
      renderIndexShell([renderBabelRelaySection("babel-relay", [run])]),
    );
  });

  it("keeps the relay-specific run-list columns", () => {
    const html = renderBabelRelaySection("babel-relay", [makeBabelRunView()]);
    expect(html).toContain("Silent div.<br>enforced");
    expect(html).toContain("Silent div.<br>equal-prose");
    expect(html).not.toContain("Best full-");
  });
});
