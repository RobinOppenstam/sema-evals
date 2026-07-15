import { describe, expect, it } from "vitest";

import type { ResultManifest } from "../../packages/core/src/schemas.js";
import { aggregateTrials } from "../lib/aggregate.js";
import { renderIndex, renderRunPage, type RunView } from "../lib/render.js";
import { getExplainer } from "../site-content/explainers.js";
import { makeTrial } from "./fixtures.js";

const HEX64 = "a".repeat(64);

function makeManifest(overrides: Partial<ResultManifest> = {}): ResultManifest {
  return {
    artifactSchemaVersion: "0.3.0",
    protocolVersion: "0.3.0",
    experimentId: "babel-relay",
    runId: "20260714T000000000Z-order-20260714",
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

function makeRunView(manifest: ResultManifest): RunView {
  const aggregate = aggregateTrials([
    makeTrial({
      scenarioId: "s1",
      condition: "equal-prose",
      seed: 0,
      metrics: { taskSuccess: true },
    }),
  ]);
  return { manifest, aggregate, dataDir: manifest.runId };
}

describe("experiment explainers on the index", () => {
  it("renders the babel-relay explainer under its section heading", () => {
    const html = renderIndex([makeRunView(makeManifest())]);
    const explainer = getExplainer("babel-relay");
    expect(explainer).toBeDefined();

    // Anchored heading, lede, "how to read" body, and the conditions list.
    expect(html).toContain('<h2 id="exp-babel-relay">babel-relay</h2>');
    expect(html).toContain('<div class="explainer">');
    expect(html).toContain(explainer!.lede);
    expect(html).toContain("How to read the results");
    expect(html).toContain('<dl class="conditions">');
    for (const condition of explainer!.conditions) {
      expect(html).toContain(`<code>${condition.term}</code>`);
      expect(html).toContain(condition.description);
    }
    expect(html).toContain(explainer!.readingNote!);

    // The explainer precedes the run list within the section.
    expect(html.indexOf('<div class="explainer">')).toBeLessThan(
      html.indexOf('<table class="runlist">'),
    );
  });

  it("renders no explainer for an experiment with no registered copy", () => {
    const manifest = makeManifest({
      experimentId: "unknown-experiment",
      conditions: ["equal-prose"],
    });
    const html = renderIndex([makeRunView(manifest)]);
    expect(getExplainer("unknown-experiment")).toBeUndefined();
    expect(html).toContain(
      '<h2 id="exp-unknown-experiment">unknown-experiment</h2>',
    );
    expect(html).not.toContain('<div class="explainer">');
  });
});

describe("experiment lede on run pages", () => {
  it("renders the lede with an about-this-experiment back-link", () => {
    const html = renderRunPage(makeRunView(makeManifest()));
    const explainer = getExplainer("babel-relay");
    expect(html).toContain(explainer!.lede);
    expect(html).toContain(
      '<a class="about-link" href="../index.html#exp-babel-relay">About this experiment</a>',
    );
    // Run pages stay focused: no full explainer block or conditions list.
    expect(html).not.toContain('<div class="explainer">');
    expect(html).not.toContain('<dl class="conditions">');
  });

  it("omits the lede for an experiment with no registered copy", () => {
    const html = renderRunPage(
      makeRunView(makeManifest({ experimentId: "unknown-experiment" })),
    );
    expect(html).not.toContain("About this experiment");
  });
});

describe("determinism", () => {
  it("renders byte-identical output across repeated calls", () => {
    const run = makeRunView(makeManifest());
    expect(renderIndex([run])).toEqual(renderIndex([run]));
    expect(renderRunPage(run)).toEqual(renderRunPage(run));
  });
});
