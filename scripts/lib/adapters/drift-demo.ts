// -------------------------------------------------------------------------
// Drift-demo site adapters (a2a-drift, x402-contract-drift, forecasting)
//
// The three protocol drift demos share one publication shape: a conditions
// ladder (baseline / voluntary / enforced), per-trial metrics flags, and a
// summary.json with one entry per condition. Field names differ per protocol
// (halts vs payments vs exclusions), so each adapter instance declares its
// counters as {summary field, metrics flag} pairs and the factory owns the
// parse, redaction, recompute-and-cross-check, and rendering.
//
// Every count shown on a page is recomputed from trials.public.jsonl; the
// committed summary.json is cross-checked and a disagreement fails the build.
// -------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { transcriptSchema } from "../../../packages/core/src/schemas.js";
import {
  assertSummaryFaithful,
  type ExperimentAdapter,
  type LoadedExperiment,
  type PromoteManifest,
  type RunFile,
} from "../adapter-support.js";
import { buildPublicTrialsJsonl } from "../public-derivative.js";
import { escapeHtml, renderExperimentCard } from "../render.js";

/** One recomputed counter: a summary field backed by a boolean metrics flag. */
export interface DriftDemoCounter {
  /** Field name in each summary.json condition entry. */
  readonly summaryField: string;
  /** Boolean flag on trial.metrics that the field counts. */
  readonly metricsFlag: string;
  /** Column header on the run page. */
  readonly label: string;
  /** Use drift-injected trials as the denominator (else all trials). */
  readonly driftScoped: boolean;
}

export interface DriftDemoAdapterConfig {
  readonly experimentId: string;
  readonly title: string;
  readonly description: string;
  readonly counters: readonly DriftDemoCounter[];
  /** Builds the overview-card headline from the latest run's recompute. */
  readonly headline: (latest: DriftDemoRunView) => string;
}

const driftDemoManifestSchema = z
  .object({
    experimentId: z.string(),
    runId: z.string(),
    mode: z.string(),
    createdAt: z.string(),
    evidenceClaim: z.string(),
    conditions: z.array(z.string()).min(1),
    orderSeed: z.number(),
    runConfiguration: z
      .object({
        provider: z.string().optional(),
        model: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type DriftDemoManifest = z.infer<typeof driftDemoManifestSchema>;

const driftDemoTrialSchema = z
  .object({
    trialId: z.string(),
    condition: z.string(),
    scenarioId: z.string(),
    driftInjected: z.boolean(),
    metrics: z.record(z.string(), z.unknown()),
    transcript: transcriptSchema.nullable(),
  })
  .passthrough();

type DriftDemoTrial = z.infer<typeof driftDemoTrialSchema>;

interface ConditionCounts {
  readonly condition: string;
  readonly trials: number;
  readonly driftTrials: number;
  readonly counts: Readonly<Record<string, number>>;
}

export interface DriftDemoRunView {
  readonly manifest: DriftDemoManifest;
  readonly conditions: readonly ConditionCounts[];
}

function metricsFlag(trial: DriftDemoTrial, flag: string): boolean {
  return trial.metrics[flag] === true;
}

function aggregate(
  config: DriftDemoAdapterConfig,
  manifest: DriftDemoManifest,
  trials: readonly DriftDemoTrial[],
): ConditionCounts[] {
  return manifest.conditions.map((condition) => {
    const inCondition = trials.filter((trial) => trial.condition === condition);
    const counts: Record<string, number> = {};
    for (const counter of config.counters) {
      counts[counter.summaryField] = inCondition.filter((trial) =>
        metricsFlag(trial, counter.metricsFlag),
      ).length;
    }
    return {
      condition,
      trials: inCondition.length,
      driftTrials: inCondition.filter((trial) => trial.driftInjected).length,
      counts,
    };
  });
}

const summaryConditionSchema = z
  .object({
    condition: z.string(),
    trials: z.number(),
    driftTrials: z.number(),
  })
  .passthrough();

function compareWithSummary(
  config: DriftDemoAdapterConfig,
  recomputed: readonly ConditionCounts[],
  summaryOnDisk: unknown,
): string[] {
  const warnings: string[] = [];
  const parsed = z
    .object({ conditions: z.array(summaryConditionSchema) })
    .safeParse(summaryOnDisk);
  if (!parsed.success) {
    return ["summary.json: invalid shape"];
  }
  for (const counts of recomputed) {
    const entry = parsed.data.conditions.find(
      (candidate) => candidate.condition === counts.condition,
    );
    if (entry === undefined) {
      warnings.push(`condition ${counts.condition}: missing from summary.json`);
      continue;
    }
    if (entry.trials !== counts.trials) {
      warnings.push(
        `${counts.condition}.trials: summary=${entry.trials}, recomputed=${counts.trials}`,
      );
    }
    if (entry.driftTrials !== counts.driftTrials) {
      warnings.push(
        `${counts.condition}.driftTrials: summary=${entry.driftTrials}, recomputed=${counts.driftTrials}`,
      );
    }
    for (const counter of config.counters) {
      const stored = entry[counter.summaryField];
      const recomputedValue = counts.counts[counter.summaryField];
      if (stored !== recomputedValue) {
        warnings.push(
          `${counts.condition}.${counter.summaryField}: summary=${String(stored)}, recomputed=${String(recomputedValue)}`,
        );
      }
    }
  }
  return warnings;
}

function ratio(numerator: number, denominator: number): string {
  return `${numerator}/${denominator}`;
}

function renderRunPage(
  config: DriftDemoAdapterConfig,
  view: DriftDemoRunView,
): string {
  const { manifest } = view;
  const runConfig = manifest.runConfiguration;
  const provenanceItems = [
    `Mode: <code>${escapeHtml(manifest.mode)}</code>`,
    ...(runConfig?.provider === undefined
      ? []
      : [`Provider: <code>${escapeHtml(runConfig.provider)}</code>`]),
    ...(runConfig?.model === undefined
      ? []
      : [`Model: <code>${escapeHtml(runConfig.model)}</code>`]),
    `Order seed: <code>${escapeHtml(String(manifest.orderSeed))}</code>`,
  ];

  const header = config.counters
    .map((counter) => `<th class="num">${escapeHtml(counter.label)}</th>`)
    .join("\n");
  const rows = view.conditions
    .map((counts) => {
      const cells = config.counters
        .map((counter) => {
          const denominator = counter.driftScoped
            ? counts.driftTrials
            : counts.trials;
          const value = counts.counts[counter.summaryField] ?? 0;
          return `<td class="num">${ratio(value, denominator)}</td>`;
        })
        .join("\n");
      return `<tr>
<td><code>${escapeHtml(counts.condition)}</code></td>
<td class="num">${counts.trials}</td>
<td class="num">${counts.driftTrials}</td>
${cells}
</tr>`;
    })
    .join("\n");

  return `<h1>${escapeHtml(config.title)} &mdash; ${escapeHtml(manifest.runId)}</h1>
<p class="lede">${escapeHtml(manifest.evidenceClaim)}</p>
<ul>
${provenanceItems.map((item) => `<li>${item}</li>`).join("\n")}
</ul>
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Condition</th>
<th class="num">Trials</th>
<th class="num">Drift trials</th>
${header}
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">Drift-scoped columns use drift-injected trials as the denominator;
the rest use all trials in the condition. Every count is recomputed from
<code>trials.public.jsonl</code> at build time.</p>`;
}

function renderExperimentSection(
  config: DriftDemoAdapterConfig,
  views: readonly DriftDemoRunView[],
): string {
  const rows = views
    .slice()
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
    .map((view) => {
      const m = view.manifest;
      const model = m.runConfiguration?.model;
      return `<tr>
<td><a href="runs/${escapeHtml(m.runId)}.html"><code>${escapeHtml(m.runId)}</code></a></td>
<td>${escapeHtml(m.createdAt)}</td>
<td><code>${escapeHtml(m.mode)}</code></td>
<td>${model === undefined ? "&mdash;" : `<code>${escapeHtml(model)}</code>`}</td>
<td>${escapeHtml(m.evidenceClaim)}</td>
</tr>`;
    })
    .join("\n");

  return `<h1>${escapeHtml(config.title)}</h1>
<p class="lede">${escapeHtml(config.description)}</p>
<p class="note">Deterministic demos validate the pipeline; model-pilot runs are
exploratory evidence about the named setup only. Not preregistered, not
confirmatory evidence.</p>
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Run</th><th>Created</th><th>Mode</th><th>Model</th><th>Evidence claim</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function renderOverviewCard(
  config: DriftDemoAdapterConfig,
  views: readonly DriftDemoRunView[],
): string {
  const sorted = views
    .slice()
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
  const latest = sorted[0];
  const models = [
    ...new Set(
      views
        .map((view) => view.manifest.runConfiguration?.model)
        .filter((model): model is string => model !== undefined),
    ),
  ].sort();

  return renderExperimentCard({
    experimentId: config.experimentId,
    lede: config.description,
    runCount: views.length,
    latestDate:
      latest === undefined ? "&mdash;" : latest.manifest.createdAt.slice(0, 10),
    models,
    headlineHtml:
      latest === undefined ? "&mdash;" : escapeHtml(config.headline(latest)),
  });
}

function parseTrials(source: string): DriftDemoTrial[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => driftDemoTrialSchema.parse(JSON.parse(line)));
}

async function loadRun(
  config: DriftDemoAdapterConfig,
  experimentDir: string,
  runId: string,
): Promise<DriftDemoRunView> {
  const runDir = join(experimentDir, runId);
  const manifest = driftDemoManifestSchema.parse(
    JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")),
  );
  const summaryOnDisk: unknown = JSON.parse(
    await readFile(join(runDir, "summary.json"), "utf8"),
  );
  const trials = parseTrials(
    await readFile(join(runDir, "trials.public.jsonl"), "utf8"),
  );
  const conditions = aggregate(config, manifest, trials);
  assertSummaryFaithful(
    config.experimentId,
    runId,
    compareWithSummary(config, conditions, summaryOnDisk),
  );
  return { manifest, conditions };
}

export function makeDriftDemoAdapter(
  config: DriftDemoAdapterConfig,
): ExperimentAdapter {
  return {
    experimentId: config.experimentId,

    parseManifest(raw: unknown): PromoteManifest {
      const manifest = driftDemoManifestSchema.parse(raw);
      if (manifest.experimentId !== config.experimentId) {
        throw new Error(
          `Manifest experimentId "${manifest.experimentId}" does not match adapter "${config.experimentId}".`,
        );
      }
      return manifest;
    },

    redactTrials(source: string): string {
      return buildPublicTrialsJsonl<DriftDemoTrial>(
        source,
        driftDemoTrialSchema,
      );
    },

    async loadExperiment(
      experimentDir: string,
      runIds: readonly string[],
    ): Promise<LoadedExperiment> {
      const views: DriftDemoRunView[] = [];
      const runs: RunFile[] = [];
      for (const runId of runIds) {
        const view = await loadRun(config, experimentDir, runId);
        views.push(view);
        runs.push({
          runId,
          createdAt: view.manifest.createdAt,
          runBody: renderRunPage(config, view),
        });
      }
      return {
        experimentId: config.experimentId,
        runs,
        experimentBody: renderExperimentSection(config, views),
        overviewCard: renderOverviewCard(config, views),
      };
    },
  };
}

function conditionByName(
  view: DriftDemoRunView,
  name: string,
): ConditionCounts | undefined {
  return view.conditions.find((counts) => counts.condition === name);
}

export const a2aDriftAdapter = makeDriftDemoAdapter({
  experimentId: "a2a-drift",
  title: "A2A Drift",
  description:
    "A2A semantic-extension middleware demo: does cross-agent registry drift execute silently, or is it detected and halted, depending only on which A2A extension point is honored?",
  counters: [
    {
      summaryField: "detected",
      metricsFlag: "driftDetected",
      label: "Detected",
      driftScoped: true,
    },
    {
      summaryField: "silentExecutions",
      metricsFlag: "silentExecution",
      label: "Silent executions",
      driftScoped: true,
    },
    {
      summaryField: "correctHalts",
      metricsFlag: "correctHalt",
      label: "Correct halts",
      driftScoped: true,
    },
    {
      summaryField: "falseHalts",
      metricsFlag: "falseHalt",
      label: "False halts",
      driftScoped: false,
    },
    {
      summaryField: "taskSuccesses",
      metricsFlag: "taskSuccess",
      label: "Task successes",
      driftScoped: false,
    },
  ],
  headline: (latest) => {
    const baseline = conditionByName(latest, "baseline");
    const enforced = conditionByName(latest, "advertised-enforced");
    if (baseline === undefined || enforced === undefined) {
      return "conditions ladder incomplete";
    }
    return (
      `Baseline: ${baseline.counts["silentExecutions"] ?? 0}/${baseline.driftTrials} drifted tasks execute silently; ` +
      `enforced: ${enforced.counts["correctHalts"] ?? 0}/${enforced.driftTrials} halted, ` +
      `${enforced.counts["falseHalts"] ?? 0} false halts.`
    );
  },
});

export const x402DriftAdapter = makeDriftDemoAdapter({
  experimentId: "x402-contract-drift",
  title: "x402 Contract Drift",
  description:
    "x402 payer–seller demo: does payment-contract drift produce silent payment, or a refusal, depending only on whether the x402 extension surface is honored?",
  counters: [
    {
      summaryField: "detected",
      metricsFlag: "driftDetected",
      label: "Detected",
      driftScoped: true,
    },
    {
      summaryField: "silentPayments",
      metricsFlag: "silentPayment",
      label: "Silent payments",
      driftScoped: true,
    },
    {
      summaryField: "correctHalts",
      metricsFlag: "correctHalt",
      label: "Correct refusals",
      driftScoped: true,
    },
    {
      summaryField: "falseHalts",
      metricsFlag: "falseHalt",
      label: "False refusals",
      driftScoped: false,
    },
    {
      summaryField: "taskSuccesses",
      metricsFlag: "taskSuccess",
      label: "Task successes",
      driftScoped: false,
    },
  ],
  headline: (latest) => {
    const baseline = conditionByName(latest, "baseline");
    const enforced = conditionByName(latest, "advertised-enforced");
    if (baseline === undefined || enforced === undefined) {
      return "conditions ladder incomplete";
    }
    return (
      `Baseline: ${baseline.counts["silentPayments"] ?? 0}/${baseline.driftTrials} drifted contracts pay silently; ` +
      `enforced: ${enforced.counts["correctHalts"] ?? 0}/${enforced.driftTrials} refused, ` +
      `${enforced.counts["falseHalts"] ?? 0} false refusals.`
    );
  },
});

export const forecastingAdapter = makeDriftDemoAdapter({
  experimentId: "forecasting",
  title: "Forecasting Council",
  description:
    "Five-agent forecast council demo: does coordination-term drift corrupt the aggregate, or is the drifted forecast detected and excluded, depending only on whether content-addressed references are honored?",
  counters: [
    {
      summaryField: "detected",
      metricsFlag: "driftDetected",
      label: "Detected",
      driftScoped: true,
    },
    {
      summaryField: "corruptedAggregations",
      metricsFlag: "corruptedAggregation",
      label: "Corrupted aggregations",
      driftScoped: true,
    },
    {
      summaryField: "correctExclusions",
      metricsFlag: "correctExclusion",
      label: "Correct exclusions",
      driftScoped: true,
    },
    {
      summaryField: "falseExclusions",
      metricsFlag: "falseExclusion",
      label: "False exclusions",
      driftScoped: false,
    },
  ],
  headline: (latest) => {
    const baseline = conditionByName(latest, "baseline");
    const enforced = conditionByName(latest, "addressed-enforced");
    if (baseline === undefined || enforced === undefined) {
      return "conditions ladder incomplete";
    }
    return (
      `Baseline: ${baseline.counts["corruptedAggregations"] ?? 0}/${baseline.driftTrials} aggregates corrupted; ` +
      `enforced: ${enforced.counts["correctExclusions"] ?? 0}/${enforced.driftTrials} drifted forecasts excluded, ` +
      `${enforced.counts["falseExclusions"] ?? 0} false exclusions.`
    );
  },
});
