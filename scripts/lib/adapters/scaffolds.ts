// Publication adapters for deterministic mechanism scaffolds.
//
// These experiments intentionally do not make model-performance claims. Each
// adapter parses the experiment's own schemas, recomputes the summary from the
// public trial derivative, and fails the site build if summary.json disagrees.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  semaDiscoveryManifestSchema,
  semaDiscoveryTrialRecordSchema,
  type SemaDiscoveryManifest,
  type SemaDiscoveryTrialRecord,
} from "../../../experiments/sema-discovery/src/schemas.js";
import {
  summarizeSemaDiscovery,
  type SemaDiscoverySummary,
} from "../../../experiments/sema-discovery/src/summary.js";
import {
  workflowValueResultManifestSchema,
  workflowValueTrialRecordSchema,
  type WorkflowValueResultManifest,
  type WorkflowValueTrialRecord,
} from "../../../experiments/workflow-value/src/schemas.js";
import {
  summarizeWorkflowValue,
  type WorkflowValueSummary,
} from "../../../experiments/workflow-value/src/summary.js";
import {
  assertSummaryFaithful,
  type ExperimentAdapter,
  type LoadedExperiment,
  type PromoteManifest,
  type RunFile,
} from "../adapter-support.js";
import { buildPublicTrialsJsonl } from "../public-derivative.js";
import { escapeHtml, renderExperimentCard } from "../render.js";

function parseJsonl<T>(source: string, parse: (value: unknown) => T): T[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parse(JSON.parse(line)));
}

function compareSummary(recomputed: unknown, stored: unknown): string[] {
  return JSON.stringify(recomputed) === JSON.stringify(stored)
    ? []
    : ["summary.json is not byte-equivalent to the recomputed summary object"];
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function number(value: number): string {
  return value.toFixed(1);
}

interface DiscoveryRunView {
  manifest: SemaDiscoveryManifest;
  summary: SemaDiscoverySummary;
}

function renderDiscoveryRun(view: DiscoveryRunView): string {
  const rows = view.summary.conditions
    .map(
      (condition) => `<tr>
<td><code>${escapeHtml(condition.condition)}</code></td>
<td class="num">${condition.trials}</td>
<td class="num">${percent(condition.endToEndSuccessRate)}</td>
<td class="num">${number(condition.meanSearches)}</td>
<td class="num">${number(condition.meanCorrectSelections)}</td>
<td class="num">${percent(condition.dependencyCompleteRate)}</td>
<td class="num">${number(condition.meanExecutionsPassed)}</td>
<td class="num">${number(condition.meanReuseHits)}</td>
<td class="num">${number(condition.meanWireBytes)}</td>
<td class="num">${number(condition.meanHydrationBytes)}</td>
</tr>`,
    )
    .join("\n");
  return `<h1>Sema discovery and session reuse &mdash; ${escapeHtml(view.manifest.runId)}</h1>
<p class="lede">${escapeHtml(view.manifest.evidenceClaim)}</p>
<p class="note">Deterministic mechanism validation only. Search, selection,
dependency resolution, execution, and reuse are scripted; these outcomes are
not evidence that a model discovers useful patterns.</p>
<ul>
<li>Mode: <code>${escapeHtml(view.manifest.mode)}</code></li>
<li>Order seed: <code>${view.manifest.orderSeed}</code></li>
<li>Session reset: <code>${escapeHtml(view.manifest.runConfiguration.sessionReset)}</code></li>
</ul>
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Condition</th><th class="num">Trials</th>
<th class="num">End-to-end</th><th class="num">Searches</th>
<th class="num">Correct selections</th><th class="num">Dependency complete</th>
<th class="num">Executions passed</th><th class="num">Reuse hits</th>
<th class="num">Wire B</th><th class="num">Hydration B</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">Every displayed aggregate is recomputed from
<code>trials.public.jsonl</code>. Wire and hydration bytes remain separate.</p>`;
}

function renderDiscoverySection(views: readonly DiscoveryRunView[]): string {
  const rows = views
    .slice()
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
    .map(
      (view) => `<tr>
<td>${escapeHtml(view.manifest.createdAt.slice(0, 10))}</td>
<td><code>${escapeHtml(view.manifest.mode)}</code></td>
<td class="num">${view.manifest.trialCount}</td>
<td><a href="runs/${escapeHtml(view.manifest.runId)}.html">Report</a></td>
</tr>`,
    )
    .join("\n");
  return `<h1>sema-discovery</h1>
<p class="lede">Deterministic search → select → dependency resolution →
execution → within-session reuse mechanism validation.</p>
<p class="note">The executor and catalog are scripted. Published results
validate mechanics and accounting only, not model discovery or workflow value.</p>
<div class="table-wrap"><table class="runlist">
<thead><tr><th>Date</th><th>Mode</th><th class="num">Trials</th><th>Report</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

async function loadDiscoveryRun(
  experimentDir: string,
  runId: string,
): Promise<DiscoveryRunView> {
  const runDir = join(experimentDir, runId);
  const manifest = semaDiscoveryManifestSchema.parse(
    JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")),
  );
  const stored: unknown = JSON.parse(
    await readFile(join(runDir, "summary.json"), "utf8"),
  );
  const records = parseJsonl(
    await readFile(join(runDir, "trials.public.jsonl"), "utf8"),
    (value) => semaDiscoveryTrialRecordSchema.parse(value),
  );
  const summary = summarizeSemaDiscovery(records);
  assertSummaryFaithful(
    manifest.experimentId,
    runId,
    compareSummary(summary, stored),
  );
  return { manifest, summary };
}

export const semaDiscoveryAdapter: ExperimentAdapter = {
  experimentId: "sema-discovery",

  parseManifest(raw: unknown): PromoteManifest {
    return semaDiscoveryManifestSchema.parse(raw);
  },

  redactTrials(source: string): string {
    return buildPublicTrialsJsonl<SemaDiscoveryTrialRecord>(
      source,
      semaDiscoveryTrialRecordSchema,
    );
  },

  async loadExperiment(
    experimentDir: string,
    runIds: readonly string[],
  ): Promise<LoadedExperiment> {
    const views: DiscoveryRunView[] = [];
    const runs: RunFile[] = [];
    for (const runId of runIds) {
      const view = await loadDiscoveryRun(experimentDir, runId);
      views.push(view);
      runs.push({
        runId,
        createdAt: view.manifest.createdAt,
        runBody: renderDiscoveryRun(view),
      });
    }
    const latest = views
      .slice()
      .sort((a, b) =>
        b.manifest.createdAt.localeCompare(a.manifest.createdAt),
      )[0];
    const discovery = latest?.summary.conditions.find(
      (condition) => condition.condition === "discovery",
    );
    return {
      experimentId: "sema-discovery",
      runs,
      experimentBody: renderDiscoverySection(views),
      overviewCard: renderExperimentCard({
        experimentId: "sema-discovery",
        lede: "Deterministic pattern discovery, dependency resolution, and within-session reuse mechanism scaffold.",
        runCount: views.length,
        latestDate: latest?.manifest.createdAt.slice(0, 10) ?? "—",
        models: views.map((view) => view.manifest.provenance.modelName),
        headlineHtml:
          discovery === undefined
            ? "&mdash;"
            : `Latest scripted discovery end-to-end success <span class="tnum">${percent(discovery.endToEndSuccessRate)}</span>`,
      }),
    };
  },
};

interface WorkflowRunView {
  manifest: WorkflowValueResultManifest;
  summary: WorkflowValueSummary;
}

function renderWorkflowRun(view: WorkflowRunView): string {
  const rows = view.summary.conditions
    .map(
      (condition) => `<tr>
<td><code>${escapeHtml(condition.condition)}</code></td>
<td class="num">${condition.trials}</td>
<td class="num">${condition.evalTrials}</td>
<td class="num">${percent(condition.evalSuccessWithinBudgetRate)}</td>
<td class="num">${percent(condition.validationPassRate)}</td>
<td class="num">${percent(condition.parseFailureRate)}</td>
<td class="num">${number(condition.meanWireBytes)}</td>
<td class="num">${number(condition.meanHydrationBytes)}</td>
<td class="num">${number(condition.meanInputTokens)}</td>
<td class="num">${number(condition.meanOutputTokens)}</td>
<td class="num">${number(condition.meanTotalModelTokens)}</td>
</tr>`,
    )
    .join("\n");
  return `<h1>Workflow value &mdash; ${escapeHtml(view.manifest.runId)}</h1>
<p class="lede">${escapeHtml(view.manifest.evidenceClaim)}</p>
<p class="note">Dataset gate:
<strong>${escapeHtml(view.manifest.datasetGate.status.toUpperCase())}</strong>.
These are synthetic seed fixtures and scripted outcomes, not an evaluation
dataset and not evidence that workflows improve model performance.</p>
<ul>
<li>Mode: <code>${escapeHtml(view.manifest.mode)}</code></li>
<li>Token budget: <code>${view.manifest.tokenBudget}</code></li>
<li>Order seed: <code>${view.manifest.orderSeed}</code></li>
</ul>
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Condition</th><th class="num">Trials</th><th class="num">Eval trials</th>
<th class="num">Eval success in budget</th><th class="num">Validator pass</th>
<th class="num">Parse failure</th><th class="num">Wire B</th>
<th class="num">Hydration B</th><th class="num">Input tok</th>
<th class="num">Output tok</th><th class="num">Total tok</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">Every displayed aggregate is recomputed from
<code>trials.public.jsonl</code>. Wire bytes, hydration bytes, input tokens, and
output tokens are reported separately.</p>`;
}

function renderWorkflowSection(views: readonly WorkflowRunView[]): string {
  const rows = views
    .slice()
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
    .map(
      (view) => `<tr>
<td>${escapeHtml(view.manifest.createdAt.slice(0, 10))}</td>
<td><code>${escapeHtml(view.manifest.mode)}</code></td>
<td><code>${escapeHtml(view.manifest.datasetGate.status)}</code></td>
<td class="num">${view.manifest.trialCount}</td>
<td><a href="runs/${escapeHtml(view.manifest.runId)}.html">Report</a></td>
</tr>`,
    )
    .join("\n");
  return `<h1>workflow-value</h1>
<p class="lede">Executable-validator workflow-delivery scaffold under a fixed
input-plus-output token budget.</p>
<p class="note">The currently published corpus is seed-only and the model gate
is closed. Results validate the runner, scorer, delivery conditions, and durable
reporting only.</p>
<div class="table-wrap"><table class="runlist">
<thead><tr><th>Date</th><th>Mode</th><th>Dataset gate</th><th class="num">Trials</th><th>Report</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

async function loadWorkflowRun(
  experimentDir: string,
  runId: string,
): Promise<WorkflowRunView> {
  const runDir = join(experimentDir, runId);
  const manifest = workflowValueResultManifestSchema.parse(
    JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")),
  );
  const stored: unknown = JSON.parse(
    await readFile(join(runDir, "summary.json"), "utf8"),
  );
  const records = parseJsonl(
    await readFile(join(runDir, "trials.public.jsonl"), "utf8"),
    (value) => workflowValueTrialRecordSchema.parse(value),
  );
  const summary = summarizeWorkflowValue(records);
  assertSummaryFaithful(
    manifest.experimentId,
    runId,
    compareSummary(summary, stored),
  );
  return { manifest, summary };
}

export const workflowValueAdapter: ExperimentAdapter = {
  experimentId: "workflow-value",

  parseManifest(raw: unknown): PromoteManifest {
    return workflowValueResultManifestSchema.parse(raw);
  },

  redactTrials(source: string): string {
    return buildPublicTrialsJsonl<WorkflowValueTrialRecord>(
      source,
      workflowValueTrialRecordSchema,
    );
  },

  async loadExperiment(
    experimentDir: string,
    runIds: readonly string[],
  ): Promise<LoadedExperiment> {
    const views: WorkflowRunView[] = [];
    const runs: RunFile[] = [];
    for (const runId of runIds) {
      const view = await loadWorkflowRun(experimentDir, runId);
      views.push(view);
      runs.push({
        runId,
        createdAt: view.manifest.createdAt,
        runBody: renderWorkflowRun(view),
      });
    }
    const latest = views
      .slice()
      .sort((a, b) =>
        b.manifest.createdAt.localeCompare(a.manifest.createdAt),
      )[0];
    return {
      experimentId: "workflow-value",
      runs,
      experimentBody: renderWorkflowSection(views),
      overviewCard: renderExperimentCard({
        experimentId: "workflow-value",
        lede: "Seed-only workflow delivery and executable-validator mechanism scaffold.",
        runCount: views.length,
        latestDate: latest?.manifest.createdAt.slice(0, 10) ?? "—",
        models: views.map((view) => view.manifest.provenance.modelName),
        headlineHtml:
          "Dataset gate <code>seed-only</code> &mdash; model pilot blocked",
      }),
    };
  },
};
