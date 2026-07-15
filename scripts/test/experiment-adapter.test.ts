import { describe, expect, it } from "vitest";

import type { ResultManifest } from "../../packages/core/src/schemas.js";
import {
  getAdapter,
  registeredExperimentIds,
  requireAdapter,
} from "../lib/experiment-adapter.js";
import { aggregateTrials } from "../lib/aggregate.js";
import {
  renderBabelRelayCard,
  renderBabelRelaySection,
  renderOverviewBody,
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

describe("babel-relay per-experiment page rendering", () => {
  it("renders a self-contained experiment page body headed by the experiment name", () => {
    const html = renderBabelRelaySection("babel-relay", [makeBabelRunView()]);
    // The section is now the per-experiment page body: h1 heading, explainer,
    // and the run list — not an h2 section spliced into a combined index.
    expect(html).toContain("<h1>babel-relay</h1>");
    expect(html).toContain('<table class="runlist">');
    expect(html).not.toContain("<h2 id=");
  });

  it("keeps the relay-specific run-list columns", () => {
    const html = renderBabelRelaySection("babel-relay", [makeBabelRunView()]);
    expect(html).toContain("Silent div.<br>enforced");
    expect(html).toContain("Silent div.<br>equal-prose");
    expect(html).not.toContain("Best full-");
  });
});

describe("overview cards", () => {
  it("renders a compact babel-relay card linking to its experiment page", () => {
    const html = renderBabelRelayCard("babel-relay", [makeBabelRunView()]);
    // Card heading links to the per-experiment page; lede and facts are present.
    expect(html).toContain(
      '<h2><a href="babel-relay/index.html">babel-relay</a></h2>',
    );
    expect(html).toContain('<p class="card-lede">');
    expect(html).toContain("<dt>Runs</dt><dd>1</dd>");
    expect(html).toContain("<dt>Latest</dt>");
    // The card always carries a headline slot (the enforced-arm figure when
    // present; the real-data integration test exercises the populated headline).
    expect(html).toContain('<p class="card-headline">');
  });

  it("composes the overview body from the intro plus a cards grid", () => {
    const card = renderBabelRelayCard("babel-relay", [makeBabelRunView()]);
    const body = renderOverviewBody([card]);
    expect(body).toContain("<h1>sema-evals</h1>");
    expect(body).toContain('<div class="cards">');
    expect(body).toContain(card);
  });

  it("renders the empty state when no experiments have runs", () => {
    const body = renderOverviewBody([]);
    expect(body).toContain("No runs have been promoted yet");
    expect(body).not.toContain('<div class="cards">');
  });
});
