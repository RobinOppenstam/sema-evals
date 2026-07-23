import type { SemaTaxSizeReuseResultManifest } from "../../experiments/sema-tax/src/size-reuse/schemas.js";
import type { SizeReuseSummary } from "../../experiments/sema-tax/src/size-reuse/summary.js";

import { escapeHtml } from "./render.js";

export interface SemaTaxSizeReuseRunView {
  manifest: SemaTaxSizeReuseResultManifest;
  summary: SizeReuseSummary;
}

function number(value: number): string {
  return value.toFixed(1);
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function renderSemaTaxSizeReuseRunPage(
  view: SemaTaxSizeReuseRunView,
): string {
  const conditionRows = view.summary.conditions
    .map(
      (condition) => `<tr>
<td>${escapeHtml(condition.size)}</td>
<td class="num">${condition.reuse}</td>
<td><code>${escapeHtml(condition.delivery)}</code></td>
<td class="num">${condition.trials}</td>
<td class="num">${condition.meanScore.toFixed(3)}</td>
<td class="num">${number(condition.meanCumulativeWireBytes)}</td>
<td class="num">${number(condition.meanCumulativeHydrationBytes)}</td>
<td class="num">${number(condition.meanTotalSemanticBytes)}</td>
<td class="num">${number(condition.meanTotalModelTokens)}</td>
<td class="num">${condition.scorePerKSemanticByte.toFixed(4)}</td>
</tr>`,
    )
    .join("\n");
  const crossingRows = view.summary.crossings
    .map(
      (crossing) => `<tr>
<td>${escapeHtml(crossing.size)}</td>
<td class="num">${crossing.reuse}</td>
<td class="num">${number(crossing.proseTotalSemanticBytes)}</td>
<td class="num">${number(crossing.contentTotalSemanticBytes)}</td>
<td>${yesNo(crossing.contentBeatsProseBytes)}</td>
<td class="num">${number(crossing.proseTotalModelTokens)}</td>
<td class="num">${number(crossing.contentTotalModelTokens)}</td>
<td>${yesNo(crossing.contentBeatsProseTokens)}</td>
</tr>`,
    )
    .join("\n");
  return `<h1>Sema tax size/reuse arm &mdash; ${escapeHtml(view.manifest.runId)}</h1>
<p class="lede">${escapeHtml(view.manifest.evidenceClaim)}</p>
<p class="note">Deterministic harness validation only. Scores and token prices
are scripted; this run measures the controlled byte and reuse geometry and is
not empirical evidence about language models.</p>
<ul>
<li>Mode: <code>${escapeHtml(view.manifest.mode)}</code></li>
<li>Pattern count: <code>p${view.manifest.patternCount}</code></li>
<li>Order seed: <code>${view.manifest.orderSeed}</code></li>
</ul>
<h2>Crossover surface</h2>
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Size</th><th class="num">R</th><th class="num">Prose semantic B</th>
<th class="num">Content semantic B</th><th>Content wins B</th>
<th class="num">Prose tok</th><th class="num">Content tok</th>
<th>Content wins tok</th>
</tr></thead>
<tbody>${crossingRows}</tbody>
</table></div>
<h2>Condition grid</h2>
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Size</th><th class="num">R</th><th>Delivery</th><th class="num">Trials</th>
<th class="num">Mean score</th><th class="num">Wire B</th>
<th class="num">Hydration B</th><th class="num">Total semantic B</th>
<th class="num">Total tok</th><th class="num">Score / 1k B</th>
</tr></thead>
<tbody>${conditionRows}</tbody>
</table></div>
<p class="note">Every displayed aggregate is recomputed from
<code>trials.public.jsonl</code>. Wire, hydration, and model-token channels are
reported separately.</p>`;
}

export function renderSemaTaxSizeReuseSection(
  views: readonly SemaTaxSizeReuseRunView[],
): string {
  if (views.length === 0) {
    return "";
  }
  const rows = views
    .slice()
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
    .map((view) => {
      const byteWins = view.summary.crossings.filter(
        (crossing) => crossing.contentBeatsProseBytes,
      ).length;
      const tokenWins = view.summary.crossings.filter(
        (crossing) => crossing.contentBeatsProseTokens,
      ).length;
      return `<tr>
<td>${escapeHtml(view.manifest.createdAt.slice(0, 10))}</td>
<td><code>${escapeHtml(view.manifest.mode)}</code></td>
<td class="num">${view.manifest.trialCount}</td>
<td class="num">${byteWins}/${view.summary.crossings.length}</td>
<td class="num">${tokenWins}/${view.summary.crossings.length}</td>
<td><a href="runs/${escapeHtml(view.manifest.runId)}.html">Report</a></td>
</tr>`;
    })
    .join("\n");
  return `<h2>Size/reuse follow-up arm</h2>
<p class="note">Pattern count is fixed at p8 while definition size and
within-session reuse vary. Deterministic results validate the crossover
measurement, not model performance.</p>
<div class="table-wrap"><table class="runlist">
<thead><tr><th>Date</th><th>Mode</th><th class="num">Trials</th>
<th class="num">Content wins bytes</th><th class="num">Content wins tokens</th>
<th>Report</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}
