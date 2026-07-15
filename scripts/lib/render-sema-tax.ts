// -------------------------------------------------------------------------
// Sema-tax site rendering
//
// The sema-tax experiment prices the token/byte/cost overhead of carrying an
// increasing number of semantic patterns. Its run page and index columns differ
// from babel-relay's relay-shaped output, so it gets its own renderers, wired in
// through the experiment-adapter registry. Every figure is recomputed from the
// public trial derivative (see sema-tax-summary.ts); nothing here reads a stored
// number it did not recompute.
// -------------------------------------------------------------------------

import type { SemaTaxResultManifest } from "../../experiments/sema-tax/src/schemas.js";
import type {
  SemaTaxConditionSummary,
  SemaTaxSummary,
} from "../../experiments/sema-tax/src/summary.js";

import { getExplainer } from "../site-content/explainers.js";

import {
  badge,
  escapeHtml,
  explainerBlock,
  provenanceList,
  renderExperimentCard,
  renderInterpretation,
} from "./render.js";

/** Deterministic date: derived from the manifest, never from the clock. */
function runDate(createdAt: string): string {
  return createdAt.slice(0, 10);
}

/** Full-precision worksheet count is 16 patterns — the completed-coverage arms. */
const FULL_COVERAGE_PATTERN_COUNT = 16;

/** Fixed-precision decimal, matching the experiment's own summary.md columns. */
function dec(value: number, digits: number): string {
  return value.toFixed(digits);
}

/** A run's manifest paired with the summary recomputed from its public trials. */
export interface SemaTaxRunView {
  manifest: SemaTaxResultManifest;
  summary: SemaTaxSummary;
  /** Directory holding the public derivative files, relative to the run page. */
  dataDir: string;
}

// -------------------------------------------------------------------------
// Run page
// -------------------------------------------------------------------------

function conditionTable(summary: SemaTaxSummary): string {
  const rows = summary.conditions
    .map((c) => {
      return `<tr>
<td><code>${escapeHtml(c.condition)}</code></td>
<td class="num">${c.trials}</td>
<td class="num">${c.patternCount}</td>
<td class="num">${dec(c.meanScore, 3)}</td>
<td class="num">${dec(c.meanAnsweredRate, 3)}</td>
<td class="num">${dec(c.meanWireBytes, 1)}</td>
<td class="num">${dec(c.meanHydrationBytes, 1)}</td>
<td class="num">${dec(c.meanInputTokens, 1)}</td>
<td class="num">${dec(c.meanCachedInputTokens, 1)}</td>
<td class="num">${dec(c.meanTotalModelTokens, 1)}</td>
<td class="num">${dec(c.scorePerKToken, 4)}</td>
</tr>`;
    })
    .join("\n");
  return `<div class="table-wrap"><table id="conditions">
<thead><tr>
<th data-sort="text" role="button">Condition</th>
<th class="num" data-sort="num" role="button">Trials</th>
<th class="num" data-sort="num" role="button">Patterns</th>
<th class="num" data-sort="num" role="button">Mean<br>score</th>
<th class="num" data-sort="num" role="button">Answered<br>rate</th>
<th class="num" data-sort="num" role="button">Wire<br>bytes</th>
<th class="num" data-sort="num" role="button">Hydration<br>bytes</th>
<th class="num" data-sort="num" role="button">Input<br>tok</th>
<th class="num" data-sort="num" role="button">Cached<br>tok</th>
<th class="num" data-sort="num" role="button">Total<br>tok</th>
<th class="num" data-sort="num" role="button">Score /<br>1k tok</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">Mean score is the graded fraction of worksheet items correct; answered rate is
format compliance (items that received a parseable line). Total tokens are billable model tokens
(fresh input + output); cached reads are counted separately. Score per 1k tokens is the primary
endpoint. Wire and hydration bytes are the controlled transport channels.</p>`;
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

export function renderSemaTaxRunPage(run: SemaTaxRunView): string {
  const m = run.manifest;

  const about = explainerBlock(m.experimentId)
    ? `<p class="lede">The Sema tax curve prices what an agent pays &mdash; in tokens, bytes, and
cost &mdash; to carry an increasing number of semantic patterns, and what that overhead buys in task
quality. <a class="about-link" href="../index.html">About this experiment</a></p>`
    : "";

  const banner = `<div class="banner banner-${m.mode}">
<div>${badge(m.mode)}</div>
<p class="claim">${escapeHtml(m.evidenceClaim)}</p>
</div>`;

  const preamble = `<p class="note">Provider prompt-cache telemetry (the cached-token column) is
<strong>observational, not controlled</strong>: the cold/warm axis controls only harness-level
hydration bytes, while a provider may cache prompt prefixes automatically across both arms (ADR
0011). The controlled cache effect is hydration bytes; read cached-token figures as description,
not manipulation.</p>`;

  return `
<p class="crumbs"><a href="../index.html">&larr; ${escapeHtml(m.experimentId)}</a></p>
<h1>${escapeHtml(m.experimentId)}</h1>
<p class="meta"><code>${escapeHtml(m.runId)}</code> &middot; ${escapeHtml(runDate(m.createdAt))} &middot; ${m.trialCount} trials across ${m.scenarioCount} scenarios</p>
${about}
${banner}
${preamble}
<h2>Provenance</h2>
${provenanceList(m)}
<h2>Results by condition</h2>
${conditionTable(run.summary)}
<h2>Raw public derivative</h2>
<p class="files">
<a href="${escapeHtml(run.dataDir)}/manifest.json">manifest.json</a>
<a href="${escapeHtml(run.dataDir)}/summary.json">summary.json</a>
<a href="${escapeHtml(run.dataDir)}/trials.public.jsonl">trials.public.jsonl</a>
</p>
<p class="note">The public derivative strips raw provider payloads and caps transcript
text. Full raw bundles are retained locally only.</p>
${SORT_SCRIPT}`;
}

// -------------------------------------------------------------------------
// Experiment page + overview card
// -------------------------------------------------------------------------

/** Highest mean worksheet score among the full-coverage (16-pattern) arms. */
function bestFullCoverageScore(summary: SemaTaxSummary): number | null {
  const full = summary.conditions.filter(
    (c: SemaTaxConditionSummary) =>
      c.patternCount === FULL_COVERAGE_PATTERN_COUNT,
  );
  if (full.length === 0) {
    return null;
  }
  return Math.max(...full.map((c) => c.meanScore));
}

/** Min/max score-per-1k-token across every condition of a run. */
function scorePerKRange(summary: SemaTaxSummary): [number, number] | null {
  if (summary.conditions.length === 0) {
    return null;
  }
  const values = summary.conditions.map((c) => c.scorePerKToken);
  return [Math.min(...values), Math.max(...values)];
}

/**
 * The sema-tax overview card: shared facts plus a headline drawn from the latest
 * run — best full-coverage score and the score-per-1k-token range.
 */
export function renderSemaTaxCard(
  experimentId: string,
  runs: readonly SemaTaxRunView[],
): string {
  const explainer = getExplainer(experimentId);
  const sorted = runs
    .slice()
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
  const latest = sorted[0];
  let headlineHtml = "&mdash;";
  if (latest !== undefined) {
    const best = bestFullCoverageScore(latest.summary);
    const range = scorePerKRange(latest.summary);
    const bestText = best === null ? "&mdash;" : dec(best, 3);
    const rangeText =
      range === null
        ? "&mdash;"
        : `${dec(range[0], 4)}&ndash;${dec(range[1], 4)}`;
    headlineHtml = `Latest &mdash; best full-coverage score <span class="tnum">${bestText}</span>, score/1k tok <span class="tnum">${rangeText}</span>`;
  }
  return renderExperimentCard({
    experimentId,
    lede: explainer?.lede ?? experimentId,
    runCount: runs.length,
    latestDate:
      latest === undefined ? "&mdash;" : runDate(latest.manifest.createdAt),
    models: [
      ...new Set(runs.map((run) => run.manifest.provenance.modelName)),
    ].sort(),
    headlineHtml,
  });
}

/**
 * The per-experiment page body for sema-tax: the experiment name as the page
 * heading, explainer, coverage-gated interpretation, and the tax-curve run list.
 * Build-site wraps this in the page chrome and writes it to
 * `<experimentId>/index.html`.
 */
export function renderSemaTaxSection(
  experimentId: string,
  runs: readonly SemaTaxRunView[],
): string {
  const promotedRunIds = runs.map((run) => run.manifest.runId);
  const rows = runs
    .slice()
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
    .map((run) => {
      const m = run.manifest;
      const best = bestFullCoverageScore(run.summary);
      const range = scorePerKRange(run.summary);
      const bestCell = best === null ? "&mdash;" : dec(best, 3);
      const rangeCell =
        range === null
          ? "&mdash;"
          : `${dec(range[0], 4)}&ndash;${dec(range[1], 4)}`;
      return `<tr>
<td>${escapeHtml(runDate(m.createdAt))}</td>
<td>${badge(m.mode)}</td>
<td><code class="model">${escapeHtml(m.provenance.modelName)}</code><code class="muted">${escapeHtml(m.provenance.modelProvider)}</code></td>
<td class="num">${m.trialCount}</td>
<td class="num">${bestCell}</td>
<td class="num">${rangeCell}</td>
<td><a href="runs/${escapeHtml(m.runId)}.html">Report</a></td>
</tr>`;
    })
    .join("\n");

  return `<h1>${escapeHtml(experimentId)}</h1>
${explainerBlock(experimentId)}
${renderInterpretation(experimentId, promotedRunIds)}
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Date</th><th>Mode</th><th>Model / provider</th>
<th class="num">Trials</th>
<th class="num">Best full-<br>coverage score</th>
<th class="num">Score / 1k tok<br>range</th>
<th>Report</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">Best full-coverage score is the highest mean worksheet score among the
sixteen-pattern arms; the score-per-1k-token range spans every condition of the run. Higher score
per token is better. Provider cache telemetry is observational (ADR 0011).</p>`;
}
