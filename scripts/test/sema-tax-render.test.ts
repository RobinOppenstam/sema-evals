import { describe, expect, it } from "vitest";

import { assertSummaryFaithful } from "../lib/adapter-support.js";
import {
  renderSemaTaxRunPage,
  renderSemaTaxSection,
  type SemaTaxRunView,
} from "../lib/render-sema-tax.js";
import {
  aggregateSemaTax,
  compareSemaTaxSummary,
} from "../lib/sema-tax-summary.js";
import { makeSemaTaxManifest, makeSemaTaxTrial } from "./sema-tax-fixtures.js";

/** A small run: a baseline arm plus two full-coverage arms with distinct scores
 *  and per-token efficiencies, recomputed with the experiment's own summarizer. */
function makeRunView(): SemaTaxRunView {
  const trials = [
    makeSemaTaxTrial({
      scenarioId: "s1",
      condition: "p0-baseline",
      seed: 0,
      metrics: {
        patternCount: 0,
        delivery: "baseline",
        cacheState: "none",
        score: 0.25,
        totalModelTokens: 2000,
        wireBytes: 550,
        hydrationBytes: 0,
      },
    }),
    makeSemaTaxTrial({
      scenarioId: "s1",
      condition: "p16-content-cold",
      seed: 0,
      metrics: {
        patternCount: 16,
        delivery: "content",
        cacheState: "cold",
        score: 0.9,
        totalModelTokens: 3000,
        wireBytes: 2149,
        hydrationBytes: 1560,
      },
    }),
    makeSemaTaxTrial({
      scenarioId: "s1",
      condition: "p16-content-warm",
      seed: 0,
      metrics: {
        patternCount: 16,
        delivery: "content",
        cacheState: "warm",
        score: 0.996,
        totalModelTokens: 3000,
        wireBytes: 2149,
        hydrationBytes: 0,
      },
    }),
  ];
  return {
    manifest: makeSemaTaxManifest(),
    summary: aggregateSemaTax(trials),
    dataDir: "20260715T103807828Z-order-20260714",
  };
}

describe("sema-tax run page", () => {
  it("renders the tax-curve condition table with all summary.md columns", () => {
    const html = renderSemaTaxRunPage(makeRunView());
    for (const header of [
      "Condition",
      "Trials",
      "Patterns",
      "Mean<br>score",
      "Answered<br>rate",
      "Wire<br>bytes",
      "Hydration<br>bytes",
      "Input<br>tok",
      "Cached<br>tok",
      "Total<br>tok",
      "Score /<br>1k tok",
    ]) {
      expect(html).toContain(header);
    }
    // Rows render every condition, mean score at 3 decimals.
    expect(html).toContain("<code>p0-baseline</code>");
    expect(html).toContain("<code>p16-content-warm</code>");
    expect(html).toContain(">0.996<");
  });

  it("carries the ADR 0011 observational-cache caveat in the preamble", () => {
    const html = renderSemaTaxRunPage(makeRunView());
    expect(html).toContain("observational, not controlled");
    expect(html).toContain("ADR");
    expect(html).toContain("0011");
  });

  it("renders the provenance definition list", () => {
    const html = renderSemaTaxRunPage(makeRunView());
    expect(html).toContain('<dl class="provenance">');
    expect(html).toContain("<dt>Model</dt>");
    expect(html).toContain("example/model");
  });

  it("is byte-identical across repeated calls", () => {
    const view = makeRunView();
    expect(renderSemaTaxRunPage(view)).toEqual(renderSemaTaxRunPage(view));
  });
});

describe("sema-tax index columns", () => {
  it("uses tax-curve columns, not relay silent-divergence columns", () => {
    const html = renderSemaTaxSection("sema-tax", [makeRunView()]);
    expect(html).toContain("Best full-<br>coverage score");
    expect(html).toContain("Score / 1k tok<br>range");
    expect(html).not.toContain("Silent div.");
  });

  it("shows the best full-coverage (p16) score and the score-per-1k range", () => {
    const html = renderSemaTaxSection("sema-tax", [makeRunView()]);
    // Best full-coverage = max mean score across the two 16-pattern arms.
    expect(html).toContain(`<td class="num">0.996</td>`);
    // Range cell joins min and max score-per-1k with an en-dash entity.
    expect(html).toMatch(/<td class="num">\d\.\d{4}&ndash;\d\.\d{4}<\/td>/);
  });

  it("renders the coverage-gated interpretation note", () => {
    const html = renderSemaTaxSection("sema-tax", [makeRunView()]);
    expect(html).toContain("One exploratory pilot on one model");
    expect(html).toContain("as of 2026-07-15");
  });
});

describe("sema-tax recompute cross-check", () => {
  it("returns no warnings when a summary matches the recomputed aggregate", () => {
    const view = makeRunView();
    expect(compareSemaTaxSummary(view.summary, view.summary)).toEqual([]);
    expect(() =>
      assertSummaryFaithful("sema-tax", view.manifest.runId, []),
    ).not.toThrow();
  });

  it("fails the build when the stored summary disagrees with the trials", () => {
    const view = makeRunView();
    const tampered = {
      ...view.summary,
      trialCount: view.summary.trialCount + 1,
      conditions: view.summary.conditions.map((c) =>
        c.condition === "p16-content-warm" ? { ...c, meanScore: 0.1 } : c,
      ),
    };
    const warnings = compareSemaTaxSummary(view.summary, tampered);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("trialCount"))).toBe(true);
    expect(warnings.some((w) => w.includes("meanScore"))).toBe(true);
    expect(() =>
      assertSummaryFaithful("sema-tax", view.manifest.runId, warnings),
    ).toThrow(/summary\.json disagrees with recomputed/);
  });
});
