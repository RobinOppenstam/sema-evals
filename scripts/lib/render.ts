import type {
  ExperimentCondition,
  ResultManifest,
} from "../../packages/core/src/schemas.js";
import { getExplainer } from "../site-content/explainers.js";
import {
  getInterpretation,
  uncoveredRunIds,
} from "../site-content/interpretations.js";
import type {
  ConditionAggregate,
  SiteAggregate,
  TrialOutcome,
} from "./aggregate.js";

/** DOM id of an experiment's index section, used as the back-link anchor. */
function experimentAnchor(experimentId: string): string {
  return `exp-${experimentId}`;
}

export interface RunView {
  manifest: ResultManifest;
  aggregate: SiteAggregate;
  /** Directory holding the public derivative files, relative to the run page. */
  dataDir: string;
}

const REPO_URL = "https://github.com/RobinOppenstam/sema-evals";
const RESEARCH_PLAN_URL = `${REPO_URL}/blob/main/docs/RESEARCH_PLAN.md`;
const STANDARD_URL = `${REPO_URL}/blob/main/docs/EXPERIMENT_STANDARD.md`;

const MODE_LABEL: Record<ResultManifest["mode"], string> = {
  "deterministic-harness": "Deterministic harness",
  "model-pilot": "Model pilot",
  confirmatory: "Confirmatory",
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function conditionDate(createdAt: string): string {
  // Deterministic: derive the date from the manifest, never from the clock.
  return createdAt.slice(0, 10);
}

// Format a number for inline SVG geometry deterministically (fixed precision so
// byte-identical rebuilds never depend on float printing).
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// -------------------------------------------------------------------------
// Stylesheet
//
// Editorial research-artifact register: a tuned system stack (no web fonts,
// self-contained + deterministic), a ~1.25 modular type scale, a small
// light/dark token set drawn from the data-viz reference palette, and marks
// styled by CSS custom properties so a single theme swap covers the SVG charts
// and the glyph grid. Monospace is reserved for identifiers, hashes and slugs.
// -------------------------------------------------------------------------
const STYLE = `
:root {
  color-scheme: light;
  --bg: #f9f9f7;
  --surface: #fcfcfb;
  --surface-2: #f2f1ec;
  --text: #0b0b0b;
  --text-2: #52514e;
  --muted: #77756f;
  --border: rgba(11, 11, 11, 0.12);
  --line: #e1e0d9;
  --axis: #c3c2b7;
  --track: #ece9e2;
  --accent: #1c5cab;
  --accent-mark: #2a78d6;
  --success: #0a7a26;
  --detect: #1c5cab;
  --warn: #9a5a00;
  --danger: #c0272b;
  /* Two categorical series hues for the findings dumbbell (validated against
     the data-viz palette checks in both light and dark; see PR notes). */
  --series-a: #2a78d6;
  --series-b: #c77f00;
  --badge-harness-fg: #52514e;
  --badge-harness-bg: #f2f1ec;
  --badge-harness-bd: rgba(11, 11, 11, 0.16);
  --badge-pilot-fg: #9a5a00;
  --badge-pilot-bg: #faf4e6;
  --badge-pilot-bd: #e3c48a;
  --badge-confirm-fg: #0a7a26;
  --badge-confirm-bg: #eef6ee;
  --badge-confirm-bd: #a9d3b4;
  --fs-xs: 0.75rem;
  --fs-sm: 0.8125rem;
  --fs-0: 0.9375rem;
  --fs-1: 1rem;
  --fs-2: 1.1875rem;
  --fs-3: 1.5rem;
  --fs-4: 1.8125rem;
  --measure: 68ch;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #0d0d0d;
    --surface: #1a1a19;
    --surface-2: #232320;
    --text: #ffffff;
    --text-2: #c3c2b7;
    --muted: #9c9a92;
    --border: rgba(255, 255, 255, 0.14);
    --line: #2c2c2a;
    --axis: #3a3a36;
    --track: #26261f;
    --accent: #6da7ec;
    --accent-mark: #3987e5;
    --success: #40bf4a;
    --detect: #6da7ec;
    --warn: #e0a24a;
    --danger: #e66767;
    /* Same two series hues: both clear the dark-mode lightness band, chroma
       floor, CVD separation and 3:1 contrast on the dark surface. */
    --series-a: #2a78d6;
    --series-b: #c77f00;
    --badge-harness-fg: #c3c2b7;
    --badge-harness-bg: #232320;
    --badge-harness-bd: rgba(255, 255, 255, 0.18);
    --badge-pilot-fg: #e0a24a;
    --badge-pilot-bg: #241d10;
    --badge-pilot-bd: #5a4622;
    --badge-confirm-fg: #57cf5f;
    --badge-confirm-bg: #12210f;
    --badge-confirm-bd: #294a2f;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.6;
  font-feature-settings: "kern" 1, "liga" 1, "calt" 1;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 1120px; margin: 0 auto; padding: 2.5rem 1.5rem 3rem; }

/* Page furniture: typographic wordmark only, hairline-separated. */
.site-head, .site-foot {
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 1.5rem;
  display: flex;
  align-items: baseline;
  gap: 0.75rem 1rem;
  flex-wrap: wrap;
}
.site-head {
  padding-top: 1.25rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--line);
}
.wordmark {
  font-family: var(--mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text);
  text-decoration: none;
}
.wordmark::before { content: "▚ "; color: var(--muted); }
.site-tag { color: var(--muted); font-size: var(--fs-xs); letter-spacing: 0.04em; text-transform: uppercase; }
.site-foot {
  padding-top: 1.25rem;
  padding-bottom: 2.5rem;
  margin-top: 1rem;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: var(--fs-sm);
  display: block;
}
.site-foot p { max-width: var(--measure); margin: 0; }

h1 {
  font-size: var(--fs-4);
  line-height: 1.2;
  letter-spacing: -0.015em;
  font-weight: 600;
  margin: 0 0 0.4rem;
}
h2 {
  font-size: var(--fs-2);
  line-height: 1.3;
  letter-spacing: -0.01em;
  font-weight: 600;
  margin: 2.75rem 0 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
}
h3 { font-size: var(--fs-1); font-weight: 600; margin: 1.5rem 0 0.5rem; }
p { margin: 0.65rem 0; max-width: var(--measure); }
a { color: var(--accent); text-underline-offset: 0.15em; }
a:hover { text-decoration-thickness: 2px; }
strong, b { font-weight: 600; }
code {
  font-family: var(--mono);
  font-size: 0.86em;
  overflow-wrap: anywhere;
}
.lede { color: var(--text-2); font-size: var(--fs-1); }
.muted { color: var(--muted); }
.tnum { font-variant-numeric: tabular-nums; }
.crumbs { font-size: var(--fs-sm); margin: 0 0 0.75rem; }
.crumbs a { color: var(--muted); text-decoration: none; }
.crumbs a:hover { color: var(--accent); text-decoration: underline; }
.meta {
  color: var(--muted);
  font-size: var(--fs-sm);
  margin: 0.25rem 0 0.5rem;
  font-variant-numeric: tabular-nums;
}
.note { color: var(--muted); font-size: var(--fs-sm); margin: 0.5rem 0 0.25rem; }
.links { color: var(--muted); font-size: var(--fs-sm); margin: 1rem 0 0; }
.links a { color: var(--accent); }

/* Mode badges: restrained, distinct tints — not saturated traffic lights. */
.badge {
  display: inline-block;
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  padding: 0.12rem 0.5rem 0.16rem;
  border-radius: 4px;
  border: 1px solid transparent;
  white-space: nowrap;
  vertical-align: 0.06em;
}
.badge-deterministic-harness { background: var(--badge-harness-bg); color: var(--badge-harness-fg); border-color: var(--badge-harness-bd); }
.badge-model-pilot { background: var(--badge-pilot-bg); color: var(--badge-pilot-fg); border-color: var(--badge-pilot-bd); }
.badge-confirmatory { background: var(--badge-confirm-bg); color: var(--badge-confirm-fg); border-color: var(--badge-confirm-bd); }

/* Evidence-claim banner: verbatim claim, mode-keyed hairline accent. */
.banner {
  border: 1px solid var(--border);
  border-left: 3px solid var(--muted);
  background: var(--surface);
  border-radius: 6px;
  padding: 0.85rem 1rem;
  margin: 1.25rem 0 1.5rem;
  max-width: none;
}
.banner-model-pilot { border-left-color: var(--warn); }
.banner-deterministic-harness { border-left-color: var(--muted); }
.banner-confirmatory { border-left-color: var(--success); }
.banner .claim { font-weight: 600; margin: 0.4rem 0 0; max-width: var(--measure); }

/* Tables: hairline rows, tabular right-aligned numerics, no forced scrollbar.
   overflow-x:auto is a graceful fallback — it only paints when a table truly
   cannot fit, which the wrapping/sizing rules prevent at desktop widths. */
.table-wrap { overflow-x: auto; margin: 0.75rem 0 0.5rem; scrollbar-width: thin; }
table { border-collapse: collapse; width: 100%; font-size: var(--fs-0); }
caption { text-align: left; color: var(--muted); font-size: var(--fs-sm); margin-bottom: 0.4rem; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: baseline; }
thead th {
  color: var(--muted);
  font-weight: 600;
  font-size: var(--fs-xs);
  letter-spacing: 0.02em;
  vertical-align: bottom;
  border-bottom: 1px solid var(--axis);
  text-wrap: balance;
}
tbody tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.num { white-space: nowrap; }
td code { overflow-wrap: anywhere; }
tbody tr:hover { background: var(--surface-2); }
th[role="button"] { cursor: pointer; user-select: none; }
th[role="button"]::after { content: " \\2195"; color: var(--axis); font-size: 0.85em; font-weight: 400; }

/* Run list on the index page. */
.runlist td:first-child { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.runlist td .model { display: block; }

/* Provenance as a definition list: labels left, full copyable values in muted
   mono one step smaller, wrapping so hashes never force width. */
.provenance {
  display: grid;
  grid-template-columns: minmax(9rem, max-content) minmax(0, 1fr);
  gap: 0;
  margin: 0.75rem 0 0.5rem;
  font-size: var(--fs-0);
  border-top: 1px solid var(--line);
}
.provenance dt {
  color: var(--text-2);
  padding: 0.4rem 1rem 0.4rem 0;
  border-bottom: 1px solid var(--line);
}
.provenance dd {
  margin: 0;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--line);
  min-width: 0;
}
.provenance dd code {
  font-size: var(--fs-sm);
  color: var(--text-2);
  overflow-wrap: anywhere;
}

/* Experiment explainer: framing prose above a run list. The conditions read as
   a definition list — slug left, what it isolates right — echoing the
   provenance grid so both themes are covered by the shared token set. */
.explainer { margin: 0.75rem 0 1.75rem; }
.explainer .lede { margin-top: 0.35rem; }
.explainer h3 { margin-top: 1.25rem; }
.conditions {
  display: grid;
  grid-template-columns: minmax(10rem, max-content) minmax(0, 1fr);
  gap: 0;
  margin: 0.85rem 0 0.5rem;
  max-width: var(--measure);
  font-size: var(--fs-0);
  border-top: 1px solid var(--line);
}
.conditions dt {
  padding: 0.4rem 1rem 0.4rem 0;
  border-bottom: 1px solid var(--line);
}
.conditions dt code {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
.conditions dd {
  margin: 0;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--line);
  color: var(--text-2);
  min-width: 0;
}
.about-link { font-size: var(--fs-sm); }

/* Charts. All ink comes from CSS custom properties so the single theme swap
   above re-colours the SVG; no hardcoded hex lives inside the markup. */
.chart { margin: 0.75rem 0 1.5rem; max-width: 760px; }
.chart svg { width: 100%; height: auto; display: block; }
.chart-grid { stroke: var(--line); stroke-width: 1; }
.chart-frame { stroke: var(--axis); stroke-width: 1; }
.chart-tick { fill: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.chart-label { fill: var(--text-2); font-family: var(--mono); font-size: 11px; }
.chart-value { fill: var(--text-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.bar-divergence { fill: var(--danger); }
.bar-success { fill: var(--success); }

/* Findings dumbbell. Two categorical series (the two models) carry the only
   colour; the connector, grid and zero line are recessive ink, and every label
   uses a text token — never a series hue. The zero line is deliberately a step
   heavier than the hairline grid because Lookup and Detection straddle it. */
.dumbbell-connector { stroke: var(--axis); stroke-width: 2; }
.chart-zero { stroke: var(--text-2); stroke-width: 1.5; }
.dumbbell-dot { stroke: var(--bg); stroke-width: 2; }
.dumbbell-a { fill: var(--series-a); }
.dumbbell-b { fill: var(--series-b); }
.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.25rem;
  margin: 0.5rem 0 0.25rem;
  color: var(--text-2);
  font-size: var(--fs-sm);
}
.chart-legend span { display: inline-flex; align-items: center; gap: 0.4rem; }
.chart-legend .swatch { width: 0.7rem; height: 0.7rem; border-radius: 50%; display: inline-block; }
.chart-legend .swatch-a { background: var(--series-a); }
.chart-legend .swatch-b { background: var(--series-b); }

/* Findings panel: computed, from the same recompute path as everything else. */
.findings { margin: 0.75rem 0 1.5rem; }
.findings h3 { margin-top: 0; }
.findings .effects td.eff { font-variant-numeric: tabular-nums; }

/* Interpretation note: the editorial reading, held in the small-print register
   and boxed like a banner so it never reads as a computed figure. */
.interpretation {
  border: 1px solid var(--border);
  border-left: 3px solid var(--muted);
  background: var(--surface);
  border-radius: 6px;
  padding: 0.85rem 1rem 0.95rem;
  margin: 1.25rem 0 1.5rem;
  max-width: none;
}
.interpretation h3 { margin: 0 0 0.35rem; font-size: var(--fs-1); }
.interpretation .asof { color: var(--muted); font-weight: 600; letter-spacing: 0.01em; }
.interpretation p { color: var(--text-2); font-size: var(--fs-sm); margin: 0.5rem 0 0; max-width: var(--measure); }

/* Per-scenario glyph grid. Fixed layout + wrapping cells keep the matrix inside
   the container regardless of how many seeds land in a cell. */
.grid-wrap { overflow-x: auto; scrollbar-width: thin; margin: 0.25rem 0 0.5rem; }
.grid { border-collapse: collapse; font-size: var(--fs-0); width: 100%; table-layout: fixed; }
.grid th, .grid td { border: 1px solid var(--line); padding: 0.35rem 0.45rem; vertical-align: top; overflow-wrap: anywhere; }
.grid thead th { background: var(--surface-2); }
.grid th:first-child, .grid td:first-child { width: 8rem; }
.grid th code, .grid td:first-child code { font-size: var(--fs-sm); }
.grid td.glyphs { white-space: normal; }
.glyphs { letter-spacing: 0.1em; font-size: 0.98rem; line-height: 1.55; }
.g-success { color: var(--success); }
.g-failure { color: var(--muted); }
.g-silent-divergence { color: var(--danger); }
.g-correct-halt { color: var(--detect); }
.g-false-halt { color: var(--warn); }
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.25rem;
  margin: 0.75rem 0 0.5rem;
  color: var(--text-2);
  font-size: var(--fs-sm);
}
.legend span { display: inline-flex; align-items: baseline; gap: 0.4rem; }
.legend .gk { font-size: 0.98rem; line-height: 1; }

.files { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; margin: 0.75rem 0 0.25rem; font-family: var(--mono); font-size: var(--fs-sm); }

@media print {
  :root { color-scheme: light; }
  body { background: #ffffff; color: #000000; }
  .site-head, .site-foot { border-color: #cccccc; }
  a { color: #000000; text-decoration: underline; }
  h2 { border-top-color: #cccccc; }
  tbody tr:hover { background: transparent; }
  .banner, .grid, table { break-inside: avoid; }
  .chart, .interpretation { break-inside: avoid; }
}
`;

function siteHeader(homeHref: string): string {
  return `<header class="site-head"><a class="wordmark" href="${homeHref}">sema-evals</a><span class="site-tag">Independent evaluations</span></header>`;
}

function siteFooter(): string {
  return `<footer class="site-foot"><p>Generated from committed result artifacts by <code>pnpm site:build</code>. Every aggregate is recomputed from the public trial derivative at build time, not read from a stored summary. <a href="${STANDARD_URL}">Experiment standard</a> &middot; <a href="${REPO_URL}">Source</a></p></footer>`;
}

function page(body: string, homeHref: string): string {
  return `${siteHeader(homeHref)}<main>${body}</main>${siteFooter()}`;
}

// The <head>/<body> skeleton is supplied by the build script; render functions
// return the full page furniture. The stylesheet is exported so the build
// script can inline it consistently across every page.
export const SITE_STYLE = STYLE;

function badge(mode: ResultManifest["mode"]): string {
  return `<span class="badge badge-${mode}">${escapeHtml(MODE_LABEL[mode])}</span>`;
}

function conditionByName(
  aggregate: SiteAggregate,
  condition: ExperimentCondition,
): ConditionAggregate | undefined {
  return aggregate.conditions.find((c) => c.condition === condition);
}

function headlineCell(
  aggregate: SiteAggregate,
  condition: ExperimentCondition,
): string {
  const c = conditionByName(aggregate, condition);
  if (c === undefined) {
    return "&mdash;";
  }
  return `${percent(c.silentDivergenceRate)} <span class="muted">(${c.silentDivergences}/${c.driftTrials})</span>`;
}

// -------------------------------------------------------------------------
// Experiment explainers
// -------------------------------------------------------------------------

// Full explainer block for the index: lede, "How to read the results" body, the
// conditions definition list, and an optional small-print reading note. Renders
// nothing for an experiment with no registered copy.
function explainerBlock(experimentId: string): string {
  const explainer = getExplainer(experimentId);
  if (explainer === undefined) {
    return "";
  }
  const body = explainer.body
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n");
  const conditions = explainer.conditions
    .map(
      (condition) =>
        `<dt><code>${escapeHtml(condition.term)}</code></dt><dd>${escapeHtml(condition.description)}</dd>`,
    )
    .join("\n");
  const readingNote =
    explainer.readingNote === undefined
      ? ""
      : `\n<p class="note">${escapeHtml(explainer.readingNote)}</p>`;
  return `<div class="explainer">
<p class="lede">${escapeHtml(explainer.lede)}</p>
<h3>How to read the results</h3>
${body}
<dl class="conditions">${conditions}</dl>${readingNote}
</div>`;
}

// -------------------------------------------------------------------------
// Findings panel (computed effect sizes + dumbbell)
//
// Every number here is derived from the same recomputed per-condition aggregate
// that drives the rest of the site — never a stored summary. Effects are
// differences in task-success rate, expressed in percentage points.
// -------------------------------------------------------------------------

/** The four decomposition effects plus the addressed-arm safety figures. */
export interface RunFindings {
  /** equal-prose − baseline (value of content alone), null if a condition is absent. */
  content: number | null;
  /** opaque-resolver − equal-prose (value of compact lookup). */
  lookup: number | null;
  /** addressed-voluntary − equal-prose (value of detection alone). */
  detection: number | null;
  /** addressed-enforced − addressed-voluntary (value of enforcement). */
  enforcement: number | null;
  /** Silent divergences summed across both addressed arms. */
  addressedSilentDivergences: number;
  /** Drift trials summed across both addressed arms (the divergence denominator). */
  addressedDriftTrials: number;
  /** False halts in the enforced arm, or null when that arm is absent. */
  enforcedFalseHalts: number | null;
  /** Trials in the enforced arm (the false-halt denominator), or null when absent. */
  enforcedTrials: number | null;
}

function taskSuccessRate(
  aggregate: SiteAggregate,
  condition: ExperimentCondition,
): number | undefined {
  return conditionByName(aggregate, condition)?.taskSuccessRate;
}

/** Effect in percentage points, or null when either condition is missing. */
function effectPp(
  aggregate: SiteAggregate,
  minuend: ExperimentCondition,
  subtrahend: ExperimentCondition,
): number | null {
  const a = taskSuccessRate(aggregate, minuend);
  const b = taskSuccessRate(aggregate, subtrahend);
  if (a === undefined || b === undefined) {
    return null;
  }
  return (a - b) * 100;
}

/** Recompute the four decomposition effects and addressed-arm safety figures. */
export function computeRunFindings(aggregate: SiteAggregate): RunFindings {
  const voluntary = conditionByName(aggregate, "addressed-voluntary");
  const enforced = conditionByName(aggregate, "addressed-enforced");
  const addressedArms = [voluntary, enforced].filter(
    (c): c is ConditionAggregate => c !== undefined,
  );
  return {
    content: effectPp(aggregate, "equal-prose", "baseline"),
    lookup: effectPp(aggregate, "opaque-resolver", "equal-prose"),
    detection: effectPp(aggregate, "addressed-voluntary", "equal-prose"),
    enforcement: effectPp(
      aggregate,
      "addressed-enforced",
      "addressed-voluntary",
    ),
    addressedSilentDivergences: addressedArms.reduce(
      (sum, c) => sum + c.silentDivergences,
      0,
    ),
    addressedDriftTrials: addressedArms.reduce(
      (sum, c) => sum + c.driftTrials,
      0,
    ),
    enforcedFalseHalts: enforced?.falseHalts ?? null,
    enforcedTrials: enforced?.trials ?? null,
  };
}

/** Signed percentage-point label at fixed precision, e.g. "+18.3" / "-2.2". */
function formatPp(value: number | null): string {
  if (value === null) {
    return "&mdash;";
  }
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}`;
}

/** Short model identifier for labels: the segment after the provider slash. */
function shortModel(modelName: string): string {
  const slash = modelName.lastIndexOf("/");
  return slash === -1 ? modelName : modelName.slice(slash + 1);
}

/**
 * The largest promoted model-pilot run per model, one per distinct model name,
 * ordered by model name so hue assignment and legend order are deterministic.
 */
export function selectLargestPilotRunPerModel(
  runs: readonly RunView[],
): RunView[] {
  const bestByModel = new Map<string, RunView>();
  for (const run of runs) {
    if (run.manifest.mode !== "model-pilot") {
      continue;
    }
    const model = run.manifest.provenance.modelName;
    const current = bestByModel.get(model);
    if (
      current === undefined ||
      run.manifest.trialCount > current.manifest.trialCount
    ) {
      bestByModel.set(model, run);
    }
  }
  return [...bestByModel.values()].sort((a, b) =>
    a.manifest.provenance.modelName.localeCompare(
      b.manifest.provenance.modelName,
    ),
  );
}

function effectsTable(pilots: readonly RunView[]): string {
  const rows = pilots
    .slice()
    .sort((a, b) => {
      const byModel = a.manifest.provenance.modelName.localeCompare(
        b.manifest.provenance.modelName,
      );
      return byModel !== 0
        ? byModel
        : a.manifest.trialCount - b.manifest.trialCount;
    })
    .map((run) => {
      const f = computeRunFindings(run.aggregate);
      const addressedRate = rateText(
        f.addressedSilentDivergences,
        f.addressedDriftTrials,
      );
      const falseHalt =
        f.enforcedFalseHalts === null || f.enforcedTrials === null
          ? "&mdash;"
          : rateText(f.enforcedFalseHalts, f.enforcedTrials);
      return `<tr>
<td><code>${escapeHtml(shortModel(run.manifest.provenance.modelName))}</code></td>
<td class="num">${run.manifest.trialCount}</td>
<td class="num eff">${formatPp(f.content)}</td>
<td class="num eff">${formatPp(f.lookup)}</td>
<td class="num eff">${formatPp(f.detection)}</td>
<td class="num eff">${formatPp(f.enforcement)}</td>
<td class="num">${addressedRate}</td>
<td class="num">${falseHalt}</td>
</tr>`;
    })
    .join("\n");
  return `<div class="table-wrap"><table class="effects">
<thead><tr>
<th>Model</th>
<th class="num">Trials</th>
<th class="num">Content<br>(pp)</th>
<th class="num">Lookup<br>(pp)</th>
<th class="num">Detection<br>alone (pp)</th>
<th class="num">Enforce&shy;ment<br>(pp)</th>
<th class="num">Addressed<br>silent div.</th>
<th class="num">Enforced<br>false halt</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

/** "n/d (pct)" with the count leading, echoing the run-page count/rate style. */
function rateText(numerator: number, denominator: number): string {
  const r = denominator === 0 ? 0 : numerator / denominator;
  return `${numerator}/${denominator} <span class="muted">(${percent(r)})</span>`;
}

interface DumbbellRow {
  label: string;
  a: number;
  b: number;
}

interface DumbbellSeries {
  label: string;
  cls: "a" | "b";
}

// Dumbbell chart: one row per effect, two dots per row (one per model) joined by
// a thin connector. One horizontal axis in percentage points with an emphasised
// zero line. Geometry is emitted at fixed precision so rebuilds stay
// byte-identical; there is no JS/hover layer — direct value labels at every dot
// are the documented static-chart compensation.
function dumbbellChart(
  rows: readonly DumbbellRow[],
  seriesA: DumbbellSeries,
  seriesB: DumbbellSeries,
): string {
  const values = rows.flatMap((row) => [row.a, row.b]);
  const domMin = Math.floor(Math.min(0, ...values) / 10) * 10;
  const domMax = Math.ceil(Math.max(0, ...values) / 10) * 10;
  const span = domMax - domMin;

  const top = 16;
  const rowH = 42;
  const labelEnd = 132;
  const plotX = 150;
  const plotW = 500;
  const width = 760;
  const plotBottom = top + rows.length * rowH;
  const height = plotBottom + 30;
  const x = (value: number): number =>
    plotX + ((value - domMin) / span) * plotW;

  const ticks: number[] = [];
  for (let t = domMin; t <= domMax; t += 10) {
    ticks.push(t);
  }
  const gridlines = ticks
    .map((t) => {
      const gx = x(t);
      const cls = t === 0 ? "chart-zero" : "chart-grid";
      return `<line class="${cls}" x1="${fmt(gx)}" y1="${top}" x2="${fmt(gx)}" y2="${plotBottom}"></line>`;
    })
    .join("");
  const tickLabels = ticks
    .map((t) => {
      const gx = x(t);
      return `<text class="chart-tick" x="${fmt(gx)}" y="${plotBottom + 16}" text-anchor="middle">${t}</text>`;
    })
    .join("");

  const marks = rows
    .map((row, index) => {
      const y = top + index * rowH + rowH / 2;
      const xa = x(row.a);
      const xb = x(row.b);
      const c1 = Math.min(xa, xb);
      const c2 = Math.max(xa, xb);
      const connector = `<line class="dumbbell-connector" x1="${fmt(c1)}" y1="${fmt(y)}" x2="${fmt(c2)}" y2="${fmt(y)}"></line>`;
      const dotA = `<circle class="dumbbell-dot dumbbell-${seriesA.cls}" cx="${fmt(xa)}" cy="${fmt(y)}" r="5"></circle>`;
      const dotB = `<circle class="dumbbell-dot dumbbell-${seriesB.cls}" cx="${fmt(xb)}" cy="${fmt(y)}" r="5"></circle>`;
      // Each value label rides its dot on the outward side, so a close pair
      // (Detection, Lookup) never collides — the labels diverge, not stack.
      const aLeft = xa <= xb;
      const labelA = valueLabel(row.a, xa, y, aLeft);
      const labelB = valueLabel(row.b, xb, y, !aLeft);
      const name = `<text class="chart-label" x="${labelEnd}" y="${fmt(y + 4)}" text-anchor="end">${escapeHtml(row.label)}</text>`;
      return `<g>${name}${connector}${dotA}${dotB}${labelA}${labelB}</g>`;
    })
    .join("\n");

  const legend = `<div class="chart-legend">
<span><span class="swatch swatch-${seriesA.cls}"></span>${escapeHtml(seriesA.label)}</span>
<span><span class="swatch swatch-${seriesB.cls}"></span>${escapeHtml(seriesB.label)}</span>
</div>`;

  return `${legend}<div class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Effect sizes in percentage points of task success, two models per effect" preserveAspectRatio="xMinYMin meet">
<g>${gridlines}${tickLabels}</g>
${marks}
</svg></div>
<p class="note">Percentage points of task success. Two dots per row &mdash; one per model, using each
model's largest promoted pilot &mdash; joined by a connector; the heavier line marks zero.</p>`;
}

// A dot's value label, anchored on its outward side (end-anchored to the left,
// start-anchored to the right) with a fixed 9px gap from the dot.
function valueLabel(
  value: number,
  cx: number,
  y: number,
  toLeft: boolean,
): string {
  const anchor = toLeft ? "end" : "start";
  const lx = toLeft ? cx - 9 : cx + 9;
  return `<text class="chart-value" x="${fmt(lx)}" y="${fmt(y + 4)}" text-anchor="${anchor}">${formatPp(value)}</text>`;
}

/**
 * The computed findings panel for an experiment: an effects table over every
 * promoted model-pilot run, plus a dumbbell of the four decomposition effects
 * using each model's largest pilot. Renders nothing when the experiment has no
 * model-pilot runs.
 */
export function renderFindingsPanel(
  experimentId: string,
  runs: readonly RunView[],
): string {
  const pilots = runs.filter((run) => run.manifest.mode === "model-pilot");
  if (pilots.length === 0) {
    return "";
  }
  const largest = selectLargestPilotRunPerModel(pilots);

  const effectRows: { label: string; key: keyof RunFindings }[] = [
    { label: "Content", key: "content" },
    { label: "Lookup", key: "lookup" },
    { label: "Detection alone", key: "detection" },
    { label: "Enforcement", key: "enforcement" },
  ];

  let chart = "";
  const modelA = largest[0];
  const modelB = largest[1];
  if (largest.length === 2 && modelA !== undefined && modelB !== undefined) {
    const fA = computeRunFindings(modelA.aggregate);
    const fB = computeRunFindings(modelB.aggregate);
    const rows: DumbbellRow[] = effectRows
      .map(({ label, key }) => {
        const a = fA[key];
        const b = fB[key];
        if (typeof a !== "number" || typeof b !== "number") {
          return undefined;
        }
        return { label, a, b };
      })
      .filter((row): row is DumbbellRow => row !== undefined);
    if (rows.length > 0) {
      const labelA = `${shortModel(modelA.manifest.provenance.modelName)} · ${modelA.manifest.trialCount} trials`;
      const labelB = `${shortModel(modelB.manifest.provenance.modelName)} · ${modelB.manifest.trialCount} trials`;
      chart = dumbbellChart(
        rows,
        { label: labelA, cls: "a" },
        { label: labelB, cls: "b" },
      );
    }
  }

  return `<div class="findings">
<h3>Findings so far</h3>
<p class="note">Effect sizes recomputed from each promoted pilot's public trials &mdash; differences in
task-success rate, in percentage points. Exploratory, not confirmatory; read the interpretation below.</p>
${effectsTable(pilots)}
${chart}
</div>`;
}

// -------------------------------------------------------------------------
// Interpretation note (editorial, coverage-gated)
// -------------------------------------------------------------------------

/**
 * The editorial interpretation note for an experiment. Renders nothing when no
 * copy is registered or the experiment has no promoted runs. FAILS the build
 * (throws) when a promoted run is not listed in the note's `coveredRunIds`, so
 * a note can never silently describe a stale slice of the promoted data.
 */
export function renderInterpretation(
  experimentId: string,
  promotedRunIds: readonly string[],
): string {
  const interpretation = getInterpretation(experimentId);
  if (interpretation === undefined || promotedRunIds.length === 0) {
    return "";
  }
  const missing = uncoveredRunIds(experimentId, promotedRunIds);
  if (missing.length > 0) {
    throw new Error(
      `Interpretation for "${experimentId}" does not cover promoted run(s): ${missing.join(", ")}. ` +
        `Update coveredRunIds (and asOf) in scripts/site-content/interpretations.ts.`,
    );
  }
  const paragraphs = interpretation.paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n");
  return `<div class="interpretation">
<h3>Interpretation <span class="asof">&mdash; as of ${escapeHtml(interpretation.asOf)}</span></h3>
${paragraphs}
</div>`;
}

// -------------------------------------------------------------------------
// Index page
// -------------------------------------------------------------------------

export function renderIndex(runs: readonly RunView[]): string {
  const byExperiment = new Map<string, RunView[]>();
  for (const run of runs) {
    const list = byExperiment.get(run.manifest.experimentId) ?? [];
    list.push(run);
    byExperiment.set(run.manifest.experimentId, list);
  }
  const experiments = [...byExperiment.keys()].sort();

  const header = `
<h1>sema-evals</h1>
<p class="lede">Open, causal evaluations for content-addressed semantics and multi-agent
coordination. Each report is generated directly from a committed result artifact &mdash; a run
manifest plus a redacted public trial derivative &mdash; and every statistic is recomputed from
those trials at build time.</p>
<p>This site is deliberately independent: it reports what the trials show, including nulls and
harness checks, and never markets a result. Runs are labelled by mode, and the distinction is
structural, not editorial. A <b>deterministic harness</b> run validates the measurement machinery
and is <em>not</em> evidence about model behaviour. A <b>model pilot</b> is exploratory and not
confirmatory. Only a <b>confirmatory</b> run tests a preregistered hypothesis.</p>
<p class="links"><a href="${REPO_URL}">Repository</a> &middot;
<a href="${RESEARCH_PLAN_URL}">Research plan</a> &middot;
<a href="${STANDARD_URL}">Experiment standard</a></p>`;

  if (runs.length === 0) {
    return page(
      `${header}<p class="lede">No runs have been promoted yet. Promote one with
<code>pnpm report:promote -- &lt;bundle-dir&gt;</code>.</p>`,
      "index.html",
    );
  }

  const sections = experiments
    .map((experimentId) => {
      const experimentRuns = byExperiment.get(experimentId) ?? [];
      const promotedRunIds = experimentRuns.map((run) => run.manifest.runId);
      const rows = experimentRuns
        .slice()
        .sort((a, b) =>
          b.manifest.createdAt.localeCompare(a.manifest.createdAt),
        )
        .map((run) => {
          const m = run.manifest;
          return `<tr>
<td>${escapeHtml(conditionDate(m.createdAt))}</td>
<td>${badge(m.mode)}</td>
<td><code class="model">${escapeHtml(m.provenance.modelName)}</code><code class="muted">${escapeHtml(m.provenance.modelProvider)}</code></td>
<td class="num">${m.trialCount}</td>
<td class="num">${headlineCell(run.aggregate, "addressed-enforced")}</td>
<td class="num">${headlineCell(run.aggregate, "equal-prose")}</td>
<td><a href="runs/${escapeHtml(m.runId)}.html">Report</a></td>
</tr>`;
        })
        .join("\n");

      return `<h2 id="${escapeHtml(experimentAnchor(experimentId))}">${escapeHtml(experimentId)}</h2>
${explainerBlock(experimentId)}
${renderFindingsPanel(experimentId, experimentRuns)}
${renderInterpretation(experimentId, promotedRunIds)}
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Date</th><th>Mode</th><th>Model / provider</th>
<th class="num">Trials</th>
<th class="num">Silent div.<br>enforced</th>
<th class="num">Silent div.<br>equal-prose</th>
<th>Report</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">Silent divergence is the share of drift trials where injected drift went
undetected and the relay proceeded &mdash; lower is better.</p>`;
    })
    .join("\n");

  return page(`${header}${sections}`, "index.html");
}

// -------------------------------------------------------------------------
// Run page
// -------------------------------------------------------------------------

interface Bar {
  label: string;
  rate: number;
  numerator: number;
  denominator: number;
}

// Path for a horizontal bar: square at the baseline (left), 4px-rounded data
// end (right), per the data-viz mark spec. Geometry is emitted at fixed
// precision so rebuilds stay byte-identical.
function barPath(x: number, y: number, w: number, h: number): string {
  if (w <= 0) {
    return "";
  }
  const r = Math.min(4, w, h / 2);
  const straight = w - r;
  return (
    `M${fmt(x)},${fmt(y)}` +
    `h${fmt(straight)}` +
    `a${fmt(r)},${fmt(r)} 0 0 1 ${fmt(r)},${fmt(r)}` +
    `v${fmt(h - 2 * r)}` +
    `a${fmt(r)},${fmt(r)} 0 0 1 ${fmt(-r)},${fmt(r)}` +
    `h${fmt(-straight)}z`
  );
}

function barChart(
  bars: readonly Bar[],
  variant: "divergence" | "success",
): string {
  const top = 12;
  const rowH = 34;
  const barH = 18;
  const labelEnd = 148;
  const plotX = 156;
  const plotW = 372;
  const valueX = plotX + plotW + 12;
  const width = 760;
  const plotBottom = top + bars.length * rowH;
  const height = plotBottom + 26;
  const fillClass = variant === "success" ? "bar-success" : "bar-divergence";

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const gridlines = ticks
    .map((t) => {
      const x = plotX + t * plotW;
      const cls = t === 0 || t === 1 ? "chart-frame" : "chart-grid";
      return `<line class="${cls}" x1="${fmt(x)}" y1="${top}" x2="${fmt(x)}" y2="${plotBottom}"></line>`;
    })
    .join("");
  const tickLabels = [0, 0.5, 1]
    .map((t) => {
      const x = plotX + t * plotW;
      const anchor = t === 0 ? "start" : t === 1 ? "end" : "middle";
      return `<text class="chart-tick" x="${fmt(x)}" y="${plotBottom + 16}" text-anchor="${anchor}">${(t * 100).toFixed(0)}%</text>`;
    })
    .join("");

  const rows = bars
    .map((bar, index) => {
      const y = top + index * rowH;
      const barY = y + (rowH - barH) / 2;
      const clamped = Math.max(0, Math.min(1, bar.rate));
      const fillW = clamped * plotW;
      const midY = barY + barH / 2 + 4;
      const value = `${percent(bar.rate)} (${bar.numerator}/${bar.denominator})`;
      const fill =
        fillW > 0
          ? `<path class="${fillClass}" d="${barPath(plotX, barY, fillW, barH)}"></path>`
          : "";
      return `<g>
<text class="chart-label" x="${labelEnd}" y="${midY}" text-anchor="end">${escapeHtml(bar.label)}</text>
${fill}
<text class="chart-value" x="${valueX}" y="${midY}">${escapeHtml(value)}</text>
</g>`;
    })
    .join("\n");

  return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMinYMin meet">
<g>${gridlines}${tickLabels}</g>
${rows}
</svg></div>`;
}

function provenanceRows(manifest: ResultManifest): [string, string][] {
  const p = manifest.provenance;
  return [
    ["Model", p.modelName],
    ["Provider", p.modelProvider],
    ["Sema version", p.semaVersion],
    ["Semantic backend", p.semanticBackend],
    ["Canonicalization version", p.canonicalizationVersion],
    ["Vocabulary root", p.vocabularyRoot === "" ? "(none)" : p.vocabularyRoot],
    ["Prompt digest", p.promptDigest],
    ["Fixture digest", p.fixtureDigest],
    ["Implementation commit", p.implementationCommit],
    ["Dependency lock digest", p.dependencyLockDigest],
    ["Protocol version", manifest.protocolVersion],
    ["Artifact schema version", manifest.artifactSchemaVersion],
    ["Order seed", String(manifest.orderSeed)],
    ["Seeds", manifest.seeds.join(", ")],
  ];
}

function provenanceList(manifest: ResultManifest): string {
  const body = provenanceRows(manifest)
    .map(
      ([key, value]) =>
        `<dt>${escapeHtml(key)}</dt><dd><code>${escapeHtml(value)}</code></dd>`,
    )
    .join("\n");
  return `<dl class="provenance">${body}</dl>`;
}

function conditionTable(aggregate: SiteAggregate): string {
  const rows = aggregate.conditions
    .map((c) => {
      return `<tr>
<td><code>${escapeHtml(c.condition)}</code></td>
<td class="num">${c.trials}</td>
<td class="num">${c.driftTrials}</td>
<td class="num">${c.taskSuccesses} <span class="muted">(${percent(c.taskSuccessRate)})</span></td>
<td class="num">${c.silentDivergences} <span class="muted">(${percent(c.silentDivergenceRate)})</span></td>
<td class="num">${c.detected} <span class="muted">(${percent(c.detectionRate)})</span></td>
<td class="num">${c.correctHalts}</td>
<td class="num">${c.falseHalts}</td>
</tr>`;
    })
    .join("\n");
  return `<div class="table-wrap"><table id="conditions">
<thead><tr>
<th data-sort="text" role="button">Condition</th>
<th class="num" data-sort="num" role="button">Trials</th>
<th class="num" data-sort="num" role="button">Drift<br>trials</th>
<th class="num" data-sort="num" role="button">Task<br>success</th>
<th class="num" data-sort="num" role="button">Silent<br>divergence</th>
<th class="num" data-sort="num" role="button">Drift<br>detected</th>
<th class="num" data-sort="num" role="button">Correct<br>halts</th>
<th class="num" data-sort="num" role="button">False<br>halts</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">Counts are absolute; parenthetical percentages use each metric's natural
denominator (silent divergence and detection over drift trials, task success over all trials).</p>`;
}

const OUTCOME_GLYPH: Record<TrialOutcome, string> = {
  success: "●",
  failure: "·",
  "silent-divergence": "▲",
  "correct-halt": "◆",
  "false-halt": "◇",
};

const OUTCOME_TITLE: Record<TrialOutcome, string> = {
  success: "task success",
  failure: "other failure",
  "silent-divergence": "silent divergence",
  "correct-halt": "correct halt",
  "false-halt": "false halt",
};

function scenarioGrid(aggregate: SiteAggregate): string {
  const conditions = aggregate.conditions.map((c) => c.condition);
  const head = conditions
    .map((condition) => `<th><code>${escapeHtml(condition)}</code></th>`)
    .join("");

  const cellByKey = new Map<
    string,
    { outcomes: TrialOutcome[]; seeds: number[] }
  >();
  for (const cell of aggregate.grid) {
    cellByKey.set(`${cell.scenarioId}|${cell.condition}`, {
      outcomes: cell.outcomes,
      seeds: cell.seeds,
    });
  }

  const rows = aggregate.scenarioIds
    .map((scenarioId) => {
      const cells = conditions
        .map((condition) => {
          const cell = cellByKey.get(`${scenarioId}|${condition}`);
          const outcomes = cell?.outcomes ?? [];
          const seeds = cell?.seeds ?? [];
          const glyphs = outcomes
            .map((outcome, i) => {
              const seed = seeds[i];
              const title =
                seed === undefined
                  ? OUTCOME_TITLE[outcome]
                  : `seed ${seed} · ${OUTCOME_TITLE[outcome]}`;
              return `<span class="g-${outcome}" title="${escapeHtml(title)}">${OUTCOME_GLYPH[outcome]}</span>`;
            })
            .join("");
          return `<td class="glyphs">${glyphs || "&mdash;"}</td>`;
        })
        .join("");
      return `<tr><th scope="row"><code>${escapeHtml(scenarioId)}</code></th>${cells}</tr>`;
    })
    .join("\n");

  const legendItems: [TrialOutcome, string][] = [
    ["success", "task success"],
    ["correct-halt", "correct halt (drift caught)"],
    ["false-halt", "false halt"],
    ["silent-divergence", "silent divergence"],
    ["failure", "other failure"],
  ];
  const legend = `<div class="legend">${legendItems
    .map(
      ([outcome, label]) =>
        `<span><span class="gk g-${outcome}">${OUTCOME_GLYPH[outcome]}</span>${escapeHtml(label)}</span>`,
    )
    .join("")}</div>`;

  return `${legend}<div class="grid-wrap"><table class="grid">
<thead><tr><th scope="col">Scenario</th>${head}</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">One glyph per trial, ordered by seed, so per-fixture patterns across seeds
are visible. Hover a glyph for its seed and outcome.</p>`;
}

const SORT_SCRIPT = `<script>
(function () {
  var table = document.getElementById("conditions");
  if (!table) return;
  var headers = table.querySelectorAll("th[role='button']");
  headers.forEach(function (th, col) {
    var asc = true;
    th.addEventListener("click", function () {
      var body = table.tBodies[0];
      var rows = Array.prototype.slice.call(body.rows);
      var numeric = th.getAttribute("data-sort") === "num";
      rows.sort(function (a, b) {
        var x = a.cells[col].textContent.trim();
        var y = b.cells[col].textContent.trim();
        if (numeric) {
          return (parseFloat(x) - parseFloat(y)) * (asc ? 1 : -1);
        }
        return x.localeCompare(y) * (asc ? 1 : -1);
      });
      asc = !asc;
      rows.forEach(function (r) { body.appendChild(r); });
    });
  });
})();
</script>`;

export function renderRunPage(run: RunView): string {
  const m = run.manifest;
  const enforced = conditionByName(run.aggregate, "addressed-enforced");
  const equalProse = conditionByName(run.aggregate, "equal-prose");

  const explainer = getExplainer(m.experimentId);
  const about =
    explainer === undefined
      ? ""
      : `<p class="lede">${escapeHtml(explainer.lede)}
<a class="about-link" href="../index.html#${escapeHtml(experimentAnchor(m.experimentId))}">About this experiment</a></p>`;

  const banner = `<div class="banner banner-${m.mode}">
<div>${badge(m.mode)}</div>
<p class="claim">${escapeHtml(m.evidenceClaim)}</p>
</div>`;

  const divergenceBars: Bar[] = run.aggregate.conditions.map((c) => ({
    label: c.condition,
    rate: c.silentDivergenceRate,
    numerator: c.silentDivergences,
    denominator: c.driftTrials,
  }));
  const successBars: Bar[] = run.aggregate.conditions.map((c) => ({
    label: c.condition,
    rate: c.taskSuccessRate,
    numerator: c.taskSuccesses,
    denominator: c.trials,
  }));

  let headline = "";
  if (enforced !== undefined && equalProse !== undefined) {
    headline = `<p class="lede">Silent divergence &mdash;
<code>addressed-enforced</code> ${percent(enforced.silentDivergenceRate)}
(${enforced.silentDivergences}/${enforced.driftTrials}) vs
<code>equal-prose</code> ${percent(equalProse.silentDivergenceRate)}
(${equalProse.silentDivergences}/${equalProse.driftTrials}).</p>`;
  }

  const body = `
<p class="crumbs"><a href="../index.html">&larr; All reports</a></p>
<h1>${escapeHtml(m.experimentId)}</h1>
<p class="meta"><code>${escapeHtml(m.runId)}</code> &middot; ${escapeHtml(conditionDate(m.createdAt))} &middot; ${m.trialCount} trials across ${m.scenarioCount} scenarios</p>
${about}
${banner}
${headline}
<h2>Provenance</h2>
${provenanceList(m)}
<h2>Results by condition</h2>
${conditionTable(run.aggregate)}
<h2>Silent divergence rate by condition</h2>
${barChart(divergenceBars, "divergence")}
<h2>Task success rate by condition</h2>
${barChart(successBars, "success")}
<h2>Per-scenario outcomes</h2>
${scenarioGrid(run.aggregate)}
<h2>Raw public derivative</h2>
<p class="files">
<a href="${escapeHtml(run.dataDir)}/manifest.json">manifest.json</a>
<a href="${escapeHtml(run.dataDir)}/summary.json">summary.json</a>
<a href="${escapeHtml(run.dataDir)}/trials.public.jsonl">trials.public.jsonl</a>
</p>
<p class="note">The public derivative strips raw provider payloads and caps transcript
text. Full raw bundles are retained locally only.</p>
${SORT_SCRIPT}`;

  return page(body, "../index.html");
}
