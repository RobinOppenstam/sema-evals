import type {
  ExperimentCondition,
  ResultManifest,
} from "../../packages/core/src/schemas.js";
import type {
  ConditionAggregate,
  SiteAggregate,
  TrialOutcome,
} from "./aggregate.js";

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

const STYLE = `
:root {
  --bg: #ffffff;
  --fg: #1a1d21;
  --muted: #6b7280;
  --line: #e2e5ea;
  --panel: #f7f8fa;
  --accent: #2451b2;
  --ok: #1f883d;
  --bad: #cf222e;
  --warn: #bc4c00;
  --info: #2451b2;
  --track: #e6e9ef;
  --badge-harness-bg: #eceff3;
  --badge-harness-fg: #3d434c;
  --badge-pilot-bg: #fff1d6;
  --badge-pilot-fg: #8a5300;
  --badge-confirm-bg: #dcf5e3;
  --badge-confirm-fg: #12622b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216;
    --fg: #e6e8eb;
    --muted: #9aa2ad;
    --line: #262b32;
    --panel: #161a20;
    --accent: #6f9bff;
    --ok: #46c266;
    --bad: #ff6b73;
    --warn: #e08a4a;
    --info: #6f9bff;
    --track: #262b32;
    --badge-harness-bg: #22272e;
    --badge-harness-fg: #c2c8d0;
    --badge-pilot-bg: #3a2c12;
    --badge-pilot-fg: #f0c07a;
    --badge-confirm-bg: #12331f;
    --badge-confirm-fg: #6fd18d;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.55;
  -webkit-text-size-adjust: 100%;
}
main { max-width: 1120px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 0.5rem; }
h2 { font-size: 1.2rem; margin: 2.25rem 0 0.75rem; }
h3 { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
a { color: var(--accent); }
p { margin: 0.5rem 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em; }
.lede { color: var(--muted); max-width: 62ch; }
.muted { color: var(--muted); }
.crumbs { font-size: 0.9rem; margin-bottom: 1rem; }
.toolbar { color: var(--muted); font-size: 0.9rem; margin: 0.25rem 0 1.5rem; }
.badge {
  display: inline-block;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  white-space: nowrap;
}
.badge-deterministic-harness { background: var(--badge-harness-bg); color: var(--badge-harness-fg); }
.badge-model-pilot { background: var(--badge-pilot-bg); color: var(--badge-pilot-fg); }
.badge-confirmatory { background: var(--badge-confirm-bg); color: var(--badge-confirm-fg); }
.banner {
  border: 1px solid var(--line);
  border-left: 4px solid var(--warn);
  background: var(--panel);
  border-radius: 6px;
  padding: 0.85rem 1rem;
  margin: 1rem 0 1.5rem;
}
.banner-pilot { border-left-color: var(--warn); }
.banner-deterministic-harness { border-left-color: var(--muted); }
.banner-confirmatory { border-left-color: var(--ok); }
.banner .claim { font-weight: 600; margin: 0.35rem 0 0; }
/* overflow-x:auto is a graceful fallback: it only paints a scrollbar when the
   table genuinely cannot fit, which the wrapping/sizing rules below prevent at
   desktop widths. scrollbar-width:thin keeps it unobtrusive on narrow screens. */
.table-wrap { overflow-x: auto; margin: 0.5rem 0 1rem; scrollbar-width: thin; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.num { white-space: nowrap; }
/* Long codes (hashes, condition ids, model names) break instead of forcing width. */
td code { overflow-wrap: anywhere; }
tbody tr:hover { background: var(--panel); }
th[role="button"] { cursor: pointer; user-select: none; }
th[role="button"]::after { content: " \\2195"; color: var(--muted); font-size: 0.8em; }
.chart { margin: 0.75rem 0 1.5rem; }
.chart svg { width: 100%; height: auto; display: block; }
.bar-track { fill: var(--track); }
.bar-fill { fill: var(--accent); }
.bar-fill-success { fill: var(--ok); }
.chart-label { fill: var(--fg); font-size: 11px; }
.chart-value { fill: var(--muted); font-size: 11px; }
.grid-wrap { overflow-x: auto; scrollbar-width: thin; }
/* Fixed layout + wrapping glyph cells keep the matrix within the container even
   with many seeds per cell, instead of growing unboundedly to the right. */
.grid { border-collapse: collapse; font-size: 0.85rem; width: 100%; table-layout: fixed; }
.grid th, .grid td { border: 1px solid var(--line); padding: 0.3rem 0.4rem; vertical-align: top; overflow-wrap: anywhere; }
.grid th:first-child, .grid td:first-child { width: 7rem; }
.grid td.glyphs { white-space: normal; }
.glyphs { letter-spacing: 0.08em; font-size: 0.95rem; line-height: 1.5; }
.g-success { color: var(--ok); }
.g-failure { color: var(--muted); }
.g-silent-divergence { color: var(--bad); }
.g-correct-halt { color: var(--info); }
.g-false-halt { color: var(--warn); }
.legend { color: var(--muted); font-size: 0.85rem; display: flex; flex-wrap: wrap; gap: 0.75rem 1.25rem; margin: 0.5rem 0 1rem; }
.legend span b { font-weight: 700; }
.files a { margin-right: 1rem; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.85rem; }
.runlist { list-style: none; padding: 0; margin: 0; }
`;

function page(body: string): string {
  return `<main>${body}<footer><p>Generated from committed result artifacts by <code>pnpm site:build</code>. Aggregates are recomputed from the public trial derivative at build time. <a href="${STANDARD_URL}">Experiment standard</a> &middot; <a href="${REPO_URL}">Source</a></p></footer></main>`;
}

// The <head>/<body> skeleton is supplied by the build script; render functions
// return the <main> content. The stylesheet is exported so the build script can
// inline it consistently across every page.
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
<h1>sema-evals public reports</h1>
<p class="lede">Open, causal evaluations for content-addressed semantics and multi-agent
coordination. Each report below is generated directly from a committed result
artifact &mdash; a run manifest plus a redacted public trial derivative &mdash; and every
statistic is recomputed from those trials at build time.</p>
<p class="lede">Runs are labelled by mode. A <b>deterministic harness</b> run validates the
measurement machinery and is <em>not</em> evidence about model behaviour. A <b>model pilot</b>
is exploratory and not confirmatory. Only a <b>confirmatory</b> run tests a preregistered
hypothesis. This distinction is structural, not editorial.</p>
<p class="toolbar"><a href="${REPO_URL}">Repository</a> &middot;
<a href="${RESEARCH_PLAN_URL}">Research plan</a> &middot;
<a href="${STANDARD_URL}">Experiment standard</a></p>`;

  if (runs.length === 0) {
    return page(
      `${header}<p class="lede">No runs have been promoted yet. Promote one with
<code>pnpm report:promote -- &lt;bundle-dir&gt;</code>.</p>`,
    );
  }

  const sections = experiments
    .map((experimentId) => {
      const rows = (byExperiment.get(experimentId) ?? [])
        .slice()
        .sort((a, b) =>
          b.manifest.createdAt.localeCompare(a.manifest.createdAt),
        )
        .map((run) => {
          const m = run.manifest;
          return `<tr>
<td>${escapeHtml(conditionDate(m.createdAt))}</td>
<td>${badge(m.mode)}</td>
<td><code>${escapeHtml(m.provenance.modelName)}</code></td>
<td><code>${escapeHtml(m.provenance.modelProvider)}</code></td>
<td class="num">${m.trialCount}</td>
<td class="num">${headlineCell(run.aggregate, "addressed-enforced")}</td>
<td class="num">${headlineCell(run.aggregate, "equal-prose")}</td>
<td><a href="runs/${escapeHtml(m.runId)}.html">View report</a></td>
</tr>`;
        })
        .join("\n");

      return `<h2>${escapeHtml(experimentId)}</h2>
<div class="table-wrap"><table>
<thead><tr>
<th>Date</th><th>Mode</th><th>Model</th><th>Provider</th>
<th class="num">Trials</th>
<th class="num">Silent div. (enforced)</th>
<th class="num">Silent div. (equal-prose)</th>
<th>Report</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="toolbar">Silent divergence is the share of drift trials where injected drift went
undetected and the relay proceeded &mdash; lower is better.</p>`;
    })
    .join("\n");

  return page(`${header}${sections}`);
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

function barChart(
  bars: readonly Bar[],
  variant: "default" | "success",
): string {
  const rowH = 40;
  const top = 8;
  const labelRight = 150;
  const trackX = 158;
  const trackW = 330;
  const valueX = trackX + trackW + 8;
  const width = 640;
  const height = top * 2 + bars.length * rowH;
  const fillClass =
    variant === "success" ? "bar-fill bar-fill-success" : "bar-fill";

  const rows = bars
    .map((bar, index) => {
      const y = top + index * rowH;
      const barY = y + 6;
      const barH = 18;
      const fillW = Math.max(0, Math.min(1, bar.rate)) * trackW;
      const value = `${percent(bar.rate)} (${bar.numerator}/${bar.denominator})`;
      return `<g>
<text class="chart-label" x="${labelRight}" y="${barY + barH / 2 + 4}" text-anchor="end">${escapeHtml(bar.label)}</text>
<rect class="bar-track" x="${trackX}" y="${barY}" width="${trackW}" height="${barH}" rx="3"></rect>
<rect class="${fillClass}" x="${trackX}" y="${barY}" width="${fillW.toFixed(2)}" height="${barH}" rx="3"></rect>
<text class="chart-value" x="${valueX}" y="${barY + barH / 2 + 4}">${escapeHtml(value)}</text>
</g>`;
    })
    .join("\n");

  return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMinYMin meet">${rows}</svg></div>`;
}

function provenanceTable(manifest: ResultManifest): string {
  const p = manifest.provenance;
  const rows: [string, string][] = [
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
  const body = rows
    .map(
      ([key, value]) =>
        `<tr><th scope="row">${escapeHtml(key)}</th><td><code>${escapeHtml(value)}</code></td></tr>`,
    )
    .join("\n");
  return `<div class="table-wrap"><table><tbody>${body}</tbody></table></div>`;
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
<th class="num" data-sort="num" role="button">Drift trials</th>
<th class="num" data-sort="num" role="button">Task success</th>
<th class="num" data-sort="num" role="button">Silent divergence</th>
<th class="num" data-sort="num" role="button">Drift detected</th>
<th class="num" data-sort="num" role="button">Correct halts</th>
<th class="num" data-sort="num" role="button">False halts</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="toolbar">Counts are absolute; parenthetical percentages use each metric's natural
denominator (silent divergence and detection over drift trials, task success over all trials).</p>`;
}

const OUTCOME_GLYPH: Record<TrialOutcome, string> = {
  success: "●",
  failure: "·",
  "silent-divergence": "▲",
  "correct-halt": "◆",
  "false-halt": "◇",
};

function scenarioGrid(aggregate: SiteAggregate): string {
  const conditions = aggregate.conditions.map((c) => c.condition);
  const head = conditions
    .map((condition) => `<th><code>${escapeHtml(condition)}</code></th>`)
    .join("");

  const cellByKey = new Map<string, TrialOutcome[]>();
  for (const cell of aggregate.grid) {
    cellByKey.set(`${cell.scenarioId}|${cell.condition}`, cell.outcomes);
  }

  const rows = aggregate.scenarioIds
    .map((scenarioId) => {
      const cells = conditions
        .map((condition) => {
          const outcomes = cellByKey.get(`${scenarioId}|${condition}`) ?? [];
          const glyphs = outcomes
            .map(
              (outcome) =>
                `<span class="g-${outcome}" title="${outcome}">${OUTCOME_GLYPH[outcome]}</span>`,
            )
            .join("");
          return `<td class="glyphs">${glyphs || "&mdash;"}</td>`;
        })
        .join("");
      return `<tr><th scope="row"><code>${escapeHtml(scenarioId)}</code></th>${cells}</tr>`;
    })
    .join("\n");

  const legend = `<div class="legend">
<span class="g-success"><b>${OUTCOME_GLYPH.success}</b> task success</span>
<span class="g-correct-halt"><b>${OUTCOME_GLYPH["correct-halt"]}</b> correct halt (drift caught)</span>
<span class="g-false-halt"><b>${OUTCOME_GLYPH["false-halt"]}</b> false halt</span>
<span class="g-silent-divergence"><b>${OUTCOME_GLYPH["silent-divergence"]}</b> silent divergence</span>
<span class="g-failure"><b>${OUTCOME_GLYPH.failure}</b> other failure</span>
</div>`;

  return `${legend}<div class="grid-wrap"><table class="grid">
<thead><tr><th scope="col">Scenario</th>${head}</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="toolbar">One glyph per trial, ordered by seed, so per-fixture patterns across seeds
are visible.</p>`;
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
<p class="toolbar"><code>${escapeHtml(m.runId)}</code> &middot; ${escapeHtml(conditionDate(m.createdAt))} &middot; ${m.trialCount} trials across ${m.scenarioCount} scenarios</p>
${banner}
${headline}
<h2>Provenance</h2>
${provenanceTable(m)}
<h2>Results by condition</h2>
${conditionTable(run.aggregate)}
<h2>Silent divergence rate by condition</h2>
${barChart(divergenceBars, "default")}
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
<p class="toolbar">The public derivative strips raw provider payloads and caps transcript
text. Full raw bundles are retained locally only.</p>
${SORT_SCRIPT}`;

  return page(body);
}
