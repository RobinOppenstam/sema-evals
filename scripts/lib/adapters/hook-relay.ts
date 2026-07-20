// -------------------------------------------------------------------------
// hook-enforcement site adapter
//
// Exploratory hook pilots share one manifest/trial shape and the same
// off/warn/enforce aggregation. One experiment id covers multiple harness/model
// runs; harness identity comes from each run manifest's provenance. Parse,
// redact, recompute-and-cross-check, and render through a single factory.
// -------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  assertSummaryFaithful,
  type ExperimentAdapter,
  type LoadedExperiment,
  type PromoteManifest,
  type RunFile,
} from "../adapter-support.js";
import { escapeHtml, renderExperimentCard } from "../render.js";

const CONDITIONS = ["off", "warn", "enforce"] as const;

type HookCondition = (typeof CONDITIONS)[number];

const hookRelayManifestSchema = z.object({
  experimentId: z.string(),
  runId: z.string(),
  mode: z.literal("exploratory"),
  createdAt: z.string().datetime(),
  evidenceClaim: z.string(),
  provenance: z.object({
    harness: z.string(),
    harnessVersion: z.string(),
    model: z.string(),
    gateIntegration: z.enum(["hook", "wrapper"]),
    gateSource: z.string(),
    recordsPath: z.string(),
  }),
  deviations: z.array(z.string()),
});

const hookRelayTrialSchema = z.object({
  trial_id: z.string(),
  condition: z.enum(["off", "warn", "enforce"]),
  scenario_id: z.string(),
  rep: z.number(),
  expected_action: z.enum(["proceed", "halt"]),
  actual_action: z.enum(["proceed", "halt"]),
  drift_injected: z.boolean(),
  drift_detected: z.boolean(),
  gate_detected: z.boolean(),
  enforcement_halted: z.boolean(),
  audit_decision: z.enum(["proceed", "halt", "malformed"]).nullable(),
  silent_divergence: z.boolean(),
  false_halt: z.boolean(),
  task_success: z.boolean(),
  hop_failed: z.boolean(),
  hops_run: z.number(),
  seconds: z.number(),
});

const hookRelayConditionSummarySchema = z.object({
  trials: z.number(),
  drift_trials: z.number(),
  detection: z.number(),
  silent_divergence: z.number(),
  drift_halted: z.number(),
  task_success: z.number(),
  false_halts: z.number(),
  malformed: z.number(),
  hop_failed: z.number(),
});

const hookRelaySummarySchema = z.object({
  conditions: z.object({
    off: hookRelayConditionSummarySchema,
    warn: hookRelayConditionSummarySchema,
    enforce: hookRelayConditionSummarySchema,
  }),
});

type HookRelayManifest = z.infer<typeof hookRelayManifestSchema>;
type HookRelayTrial = z.infer<typeof hookRelayTrialSchema>;
type HookRelaySummary = z.infer<typeof hookRelaySummarySchema>;
type HookRelayConditionSummary = z.infer<
  typeof hookRelayConditionSummarySchema
>;

export interface HookRelayAdapterConfig {
  readonly experimentId: string;
  readonly title: string;
  readonly description: string;
}

interface HookRelayRunView {
  manifest: HookRelayManifest;
  summary: HookRelaySummary;
}

function parseTrials(source: string): HookRelayTrial[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => hookRelayTrialSchema.parse(JSON.parse(line)));
}

function aggregateTrials(trials: readonly HookRelayTrial[]): HookRelaySummary {
  const conditions = {} as Record<HookCondition, HookRelayConditionSummary>;
  for (const condition of CONDITIONS) {
    const inCondition = trials.filter((trial) => trial.condition === condition);
    const driftInjected = inCondition.filter((trial) => trial.drift_injected);
    conditions[condition] = {
      trials: inCondition.length,
      drift_trials: driftInjected.length,
      detection: driftInjected.filter((trial) => trial.drift_detected).length,
      silent_divergence: driftInjected.filter(
        (trial) => trial.silent_divergence,
      ).length,
      drift_halted: driftInjected.filter(
        (trial) => trial.actual_action === "halt",
      ).length,
      task_success: inCondition.filter((trial) => trial.task_success).length,
      false_halts: inCondition.filter((trial) => trial.false_halt).length,
      malformed: inCondition.filter(
        (trial) => trial.audit_decision === "malformed",
      ).length,
      hop_failed: inCondition.filter((trial) => trial.hop_failed).length,
    };
  }
  return { conditions };
}

const SUMMARY_FIELDS: readonly (keyof HookRelayConditionSummary)[] = [
  "trials",
  "drift_trials",
  "detection",
  "silent_divergence",
  "drift_halted",
  "task_success",
  "false_halts",
  "malformed",
  "hop_failed",
];

function compareWithSummary(
  recomputed: HookRelaySummary,
  summaryOnDisk: unknown,
): string[] {
  const warnings: string[] = [];
  const parsed = hookRelaySummarySchema.safeParse(summaryOnDisk);
  if (!parsed.success) {
    warnings.push("summary.json: invalid shape");
    return warnings;
  }
  for (const condition of CONDITIONS) {
    const recomputedCondition = recomputed.conditions[condition];
    const summaryCondition = parsed.data.conditions[condition];
    for (const field of SUMMARY_FIELDS) {
      if (summaryCondition[field] !== recomputedCondition[field]) {
        warnings.push(
          `${condition}.${field}: summary=${summaryCondition[field]}, recomputed=${recomputedCondition[field]}`,
        );
      }
    }
  }
  return warnings;
}

function conditionDate(createdAt: string): string {
  return createdAt.slice(0, 10);
}

function ratioCell(numerator: number, denominator: number): string {
  return `${numerator}/${denominator}`;
}

function renderRunPage(
  config: HookRelayAdapterConfig,
  view: HookRelayRunView,
): string {
  const { manifest, summary } = view;
  const p = manifest.provenance;

  const deviationList =
    manifest.deviations.length === 0
      ? ""
      : `<h2>Deviations</h2>
<ul>${manifest.deviations.map((deviation) => `<li>${escapeHtml(deviation)}</li>`).join("\n")}</ul>`;

  const rows = CONDITIONS.map((condition) => {
    const c = summary.conditions[condition];
    return `<tr>
<td><code>${escapeHtml(condition)}</code></td>
<td class="num">${c.trials}</td>
<td class="num">${ratioCell(c.detection, c.drift_trials)}</td>
<td class="num">${ratioCell(c.silent_divergence, c.drift_trials)}</td>
<td class="num">${ratioCell(c.drift_halted, c.drift_trials)}</td>
<td class="num">${ratioCell(c.task_success, c.trials)}</td>
<td class="num">${c.false_halts}</td>
<td class="num">${c.malformed}</td>
<td class="num">${c.hop_failed}</td>
</tr>`;
  }).join("\n");

  return `<h1>${escapeHtml(config.title)} &mdash; ${escapeHtml(manifest.runId)}</h1>
<p class="lede">${escapeHtml(manifest.evidenceClaim)}</p>
<h2>Provenance</h2>
<ul>
<li>Harness: ${escapeHtml(p.harness)}</li>
<li>Version: ${escapeHtml(p.harnessVersion)}</li>
<li>Model: ${escapeHtml(p.model)}</li>
<li>Gate integration: ${escapeHtml(p.gateIntegration)}</li>
<li>Gate source: ${escapeHtml(p.gateSource)}</li>
<li>Records path: ${escapeHtml(p.recordsPath)}</li>
</ul>
${deviationList}
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Condition</th>
<th class="num">Trials</th>
<th class="num">Drift detection</th>
<th class="num">Silent divergence</th>
<th class="num">Drift halted</th>
<th class="num">Task success</th>
<th class="num">False halts</th>
<th class="num">Malformed</th>
<th class="num">Hop failed</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">Drift-conditioned columns use drift-injected trials as the denominator;
task success uses all trials in the condition.</p>`;
}

function sortedRunViews(
  views: readonly HookRelayRunView[],
): HookRelayRunView[] {
  return views
    .slice()
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

function renderCrossHarnessComparisonTable(
  views: readonly HookRelayRunView[],
): string {
  const rows = sortedRunViews(views)
    .map((view) => {
      const m = view.manifest;
      const p = m.provenance;
      const off = view.summary.conditions.off;
      const warn = view.summary.conditions.warn;
      const enforce = view.summary.conditions.enforce;
      return `<tr>
<td><a href="runs/${escapeHtml(m.runId)}.html"><code>${escapeHtml(m.runId)}</code></a></td>
<td>${escapeHtml(p.harness)} / <code>${escapeHtml(p.model)}</code></td>
<td><code>${escapeHtml(p.gateIntegration)}</code></td>
<td class="num">${ratioCell(off.drift_trials - off.drift_halted, off.drift_trials)}</td>
<td class="num">${ratioCell(warn.detection, warn.drift_trials)}</td>
<td class="num">${ratioCell(warn.drift_trials - warn.drift_halted, warn.drift_trials)}</td>
<td class="num">${ratioCell(enforce.drift_halted, enforce.drift_trials)}</td>
</tr>`;
    })
    .join("\n");

  return `<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Run</th>
<th>Harness / model</th>
<th>Gate tier</th>
<th class="num">Off: shipped</th>
<th class="num">Warn: detection</th>
<th class="num">Warn: shipped anyway</th>
<th class="num">Enforce: drift halted</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function renderExperimentSection(
  config: HookRelayAdapterConfig,
  views: readonly HookRelayRunView[],
): string {
  const rows = sortedRunViews(views)
    .map((view) => {
      const m = view.manifest;
      return `<tr>
<td><a href="runs/${escapeHtml(m.runId)}.html"><code>${escapeHtml(m.runId)}</code></a></td>
<td>${escapeHtml(m.createdAt)}</td>
<td><code>${escapeHtml(m.provenance.harness)}</code></td>
<td><code>${escapeHtml(m.provenance.gateIntegration)}</code></td>
<td><code>${escapeHtml(m.provenance.model)}</code></td>
<td>${escapeHtml(m.evidenceClaim)}</td>
</tr>`;
    })
    .join("\n");

  return `<h1>${escapeHtml(config.title)}</h1>
<p class="lede">${escapeHtml(config.description)}</p>
<p class="note">Exploratory pilots. Not preregistered, not confirmatory evidence.</p>
<p class="note">Per-run methodology, deviations, and raw records live under <code>experiments/babel-hook/</code>, <code>experiments/codex-hook/</code>, and <code>experiments/cursor-hook/</code> in the repository.</p>
${renderCrossHarnessComparisonTable(views)}
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Run</th><th>Created</th><th>Harness</th><th>Gate tier</th><th>Model</th><th>Evidence claim</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function renderOverviewCard(
  config: HookRelayAdapterConfig,
  views: readonly HookRelayRunView[],
): string {
  const sorted = sortedRunViews(views);
  const latest = sorted[0];
  const models = [
    ...new Set(views.map((view) => view.manifest.provenance.model)),
  ].sort();

  let headlineHtml = "&mdash;";
  if (views.length > 0) {
    const warnLeakPercents = views
      .map((view) => {
        const warn = view.summary.conditions.warn;
        if (warn.drift_trials === 0) {
          return undefined;
        }
        return Math.round(
          (100 * (warn.drift_trials - warn.drift_halted)) / warn.drift_trials,
        );
      })
      .filter((value): value is number => value !== undefined);

    const enforceHalted = views.reduce(
      (sum, view) => sum + view.summary.conditions.enforce.drift_halted,
      0,
    );
    const enforceTrials = views.reduce(
      (sum, view) => sum + view.summary.conditions.enforce.drift_trials,
      0,
    );

    if (warnLeakPercents.length > 0) {
      const minPct = Math.min(...warnLeakPercents);
      const maxPct = Math.max(...warnLeakPercents);
      headlineHtml = escapeHtml(
        `Voluntary-leak span across ${views.length} runs: ${minPct}%–${maxPct}%; enforcement ${enforceHalted}/${enforceTrials} halted.`,
      );
    }
  }

  return renderExperimentCard({
    experimentId: config.experimentId,
    lede: config.description,
    runCount: views.length,
    latestDate:
      latest === undefined
        ? "&mdash;"
        : conditionDate(latest.manifest.createdAt),
    models,
    headlineHtml,
  });
}

async function loadRun(
  experimentId: string,
  experimentDir: string,
  runId: string,
): Promise<HookRelayRunView> {
  const runDir = join(experimentDir, runId);
  const manifest = hookRelayManifestSchema.parse(
    JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")),
  );
  const summaryOnDisk: unknown = JSON.parse(
    await readFile(join(runDir, "summary.json"), "utf8"),
  );
  const records = parseTrials(
    await readFile(join(runDir, "trials.public.jsonl"), "utf8"),
  );
  const summary = aggregateTrials(records);
  assertSummaryFaithful(
    experimentId,
    runId,
    compareWithSummary(summary, summaryOnDisk),
  );
  return { manifest, summary };
}

export function makeHookRelayAdapter(
  config: HookRelayAdapterConfig,
): ExperimentAdapter {
  return {
    experimentId: config.experimentId,

    parseManifest(raw: unknown): PromoteManifest {
      const manifest = hookRelayManifestSchema.parse(raw);
      if (manifest.experimentId !== config.experimentId) {
        throw new Error(
          `Manifest experimentId "${manifest.experimentId}" does not match adapter "${config.experimentId}".`,
        );
      }
      return manifest;
    },

    redactTrials(source: string): string {
      const lines = source
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => hookRelayTrialSchema.parse(JSON.parse(line)))
        .map((record) => JSON.stringify(record));
      return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    },

    async loadExperiment(
      experimentDir: string,
      runIds: readonly string[],
    ): Promise<LoadedExperiment> {
      const views: HookRelayRunView[] = [];
      const runs: RunFile[] = [];
      for (const runId of runIds) {
        const view = await loadRun(config.experimentId, experimentDir, runId);
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

const HOOK_ENFORCEMENT_DESCRIPTION =
  "Replays of the babel-relay drift scenarios through real agent harnesses with the sema ref-gate enforcing at the harness boundary; one experiment, multiple harness/model runs.";

export const hookEnforcementAdapter = makeHookRelayAdapter({
  experimentId: "hook-enforcement",
  title: "Hook Enforcement",
  description: HOOK_ENFORCEMENT_DESCRIPTION,
});
