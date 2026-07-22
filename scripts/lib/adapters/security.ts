// -------------------------------------------------------------------------
// security site adapter
//
// Mutation-backed Solidity instrumentation runs: per condition, an auditor
// output is scored against ground-truth findings under a fixed false-positive
// budget. Totals shown on a page are recomputed from trials.public.jsonl and
// cross-checked against the committed summary.json; a disagreement fails the
// build.
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

const EXPERIMENT_ID = "security";

const securityManifestSchema = z
  .object({
    experimentId: z.string(),
    runId: z.string(),
    mode: z.string(),
    createdAt: z.string(),
    evidenceClaim: z.string(),
    conditions: z.array(z.string()).min(1),
    fpBudget: z.number(),
  })
  .passthrough();

type SecurityManifest = z.infer<typeof securityManifestSchema>;

const securityTrialSchema = z
  .object({
    trialId: z.string(),
    condition: z.string(),
    scenarioId: z.string(),
    metrics: z
      .object({
        truePositives: z.number(),
        falsePositives: z.number(),
        falseNegatives: z.number(),
        parseFailure: z.boolean(),
        enforcementRefused: z.boolean(),
      })
      .passthrough(),
    transcript: transcriptSchema.nullable(),
  })
  .passthrough();

type SecurityTrial = z.infer<typeof securityTrialSchema>;

interface ConditionTotals {
  readonly condition: string;
  readonly trials: number;
  readonly totalTruePositives: number;
  readonly totalFalsePositives: number;
  readonly totalFalseNegatives: number;
  readonly parseFailures: number;
  readonly enforcementRefusals: number;
}

interface SecurityRunView {
  readonly manifest: SecurityManifest;
  readonly conditions: readonly ConditionTotals[];
}

function aggregate(
  manifest: SecurityManifest,
  trials: readonly SecurityTrial[],
): ConditionTotals[] {
  return manifest.conditions.map((condition) => {
    const inCondition = trials.filter((trial) => trial.condition === condition);
    const sum = (pick: (trial: SecurityTrial) => number): number =>
      inCondition.reduce((total, trial) => total + pick(trial), 0);
    return {
      condition,
      trials: inCondition.length,
      totalTruePositives: sum((trial) => trial.metrics.truePositives),
      totalFalsePositives: sum((trial) => trial.metrics.falsePositives),
      totalFalseNegatives: sum((trial) => trial.metrics.falseNegatives),
      parseFailures: inCondition.filter((trial) => trial.metrics.parseFailure)
        .length,
      enforcementRefusals: inCondition.filter(
        (trial) => trial.metrics.enforcementRefused,
      ).length,
    };
  });
}

const summaryConditionSchema = z
  .object({
    condition: z.string(),
    trials: z.number(),
    totalTruePositives: z.number(),
    totalFalsePositives: z.number(),
    totalFalseNegatives: z.number(),
    parseFailures: z.number(),
    enforcementRefusals: z.number(),
  })
  .passthrough();

const COMPARED_FIELDS = [
  "trials",
  "totalTruePositives",
  "totalFalsePositives",
  "totalFalseNegatives",
  "parseFailures",
  "enforcementRefusals",
] as const;

function compareWithSummary(
  recomputed: readonly ConditionTotals[],
  summaryOnDisk: unknown,
): string[] {
  const warnings: string[] = [];
  const parsed = z
    .object({ conditions: z.array(summaryConditionSchema) })
    .safeParse(summaryOnDisk);
  if (!parsed.success) {
    return ["summary.json: invalid shape"];
  }
  for (const totals of recomputed) {
    const entry = parsed.data.conditions.find(
      (candidate) => candidate.condition === totals.condition,
    );
    if (entry === undefined) {
      warnings.push(`condition ${totals.condition}: missing from summary.json`);
      continue;
    }
    for (const field of COMPARED_FIELDS) {
      if (entry[field] !== totals[field]) {
        warnings.push(
          `${totals.condition}.${field}: summary=${entry[field]}, recomputed=${totals[field]}`,
        );
      }
    }
  }
  return warnings;
}

function renderRunPage(view: SecurityRunView): string {
  const { manifest } = view;
  const rows = view.conditions
    .map(
      (totals) => `<tr>
<td><code>${escapeHtml(totals.condition)}</code></td>
<td class="num">${totals.trials}</td>
<td class="num">${totals.totalTruePositives}</td>
<td class="num">${totals.totalFalsePositives}</td>
<td class="num">${totals.totalFalseNegatives}</td>
<td class="num">${totals.parseFailures}</td>
<td class="num">${totals.enforcementRefusals}</td>
</tr>`,
    )
    .join("\n");

  return `<h1>Security &mdash; ${escapeHtml(manifest.runId)}</h1>
<p class="lede">${escapeHtml(manifest.evidenceClaim)}</p>
<ul>
<li>Mode: <code>${escapeHtml(manifest.mode)}</code></li>
<li>False-positive budget: <code>${escapeHtml(String(manifest.fpBudget))}</code> per case</li>
</ul>
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Condition</th>
<th class="num">Trials</th>
<th class="num">True positives</th>
<th class="num">False positives</th>
<th class="num">False negatives</th>
<th class="num">Parse failures</th>
<th class="num">Enforcement refusals</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">Totals are summed over all cases in the condition and recomputed
from <code>trials.public.jsonl</code> at build time. Rate-style endpoints
(recall at the FP budget) live in the committed <code>summary.json</code>.</p>`;
}

function renderExperimentSection(views: readonly SecurityRunView[]): string {
  const rows = views
    .slice()
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
    .map(
      (view) => `<tr>
<td><a href="runs/${escapeHtml(view.manifest.runId)}.html"><code>${escapeHtml(view.manifest.runId)}</code></a></td>
<td>${escapeHtml(view.manifest.createdAt)}</td>
<td><code>${escapeHtml(view.manifest.mode)}</code></td>
<td>${escapeHtml(view.manifest.evidenceClaim)}</td>
</tr>`,
    )
    .join("\n");

  return `<h1>Security</h1>
<p class="lede">Mutation-backed Solidity evaluation: vulnerability recall at a
fixed false-positive budget, with patched clean negatives.</p>
<p class="note">Instrumentation runs validate the scorer and pipeline
deterministically; no model-driven security evidence is published yet.</p>
<div class="table-wrap"><table class="runlist">
<thead><tr>
<th>Run</th><th>Created</th><th>Mode</th><th>Evidence claim</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function renderOverviewCard(views: readonly SecurityRunView[]): string {
  const sorted = views
    .slice()
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
  const latest = sorted[0];
  let headline = "&mdash;";
  if (latest !== undefined) {
    const enforced = latest.conditions.find(
      (totals) => totals.condition === "addressed-enforced",
    );
    if (enforced !== undefined) {
      headline = escapeHtml(
        `Instrumentation: ${enforced.totalTruePositives} TP / ${enforced.totalFalsePositives} FP under the enforced condition, scorer-validated.`,
      );
    }
  }
  return renderExperimentCard({
    experimentId: EXPERIMENT_ID,
    lede: "Vulnerability recall at a fixed false-positive budget on mutation-backed Solidity cases.",
    runCount: views.length,
    latestDate:
      latest === undefined ? "&mdash;" : latest.manifest.createdAt.slice(0, 10),
    models: [],
    headlineHtml: headline,
  });
}

function parseTrials(source: string): SecurityTrial[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => securityTrialSchema.parse(JSON.parse(line)));
}

async function loadRun(
  experimentDir: string,
  runId: string,
): Promise<SecurityRunView> {
  const runDir = join(experimentDir, runId);
  const manifest = securityManifestSchema.parse(
    JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")),
  );
  const summaryOnDisk: unknown = JSON.parse(
    await readFile(join(runDir, "summary.json"), "utf8"),
  );
  const trials = parseTrials(
    await readFile(join(runDir, "trials.public.jsonl"), "utf8"),
  );
  const conditions = aggregate(manifest, trials);
  assertSummaryFaithful(
    EXPERIMENT_ID,
    runId,
    compareWithSummary(conditions, summaryOnDisk),
  );
  return { manifest, conditions };
}

export const securityAdapter: ExperimentAdapter = {
  experimentId: EXPERIMENT_ID,

  parseManifest(raw: unknown): PromoteManifest {
    const manifest = securityManifestSchema.parse(raw);
    if (manifest.experimentId !== EXPERIMENT_ID) {
      throw new Error(
        `Manifest experimentId "${manifest.experimentId}" does not match adapter "${EXPERIMENT_ID}".`,
      );
    }
    return manifest;
  },

  redactTrials(source: string): string {
    return buildPublicTrialsJsonl<SecurityTrial>(source, securityTrialSchema);
  },

  async loadExperiment(
    experimentDir: string,
    runIds: readonly string[],
  ): Promise<LoadedExperiment> {
    const views: SecurityRunView[] = [];
    const runs: RunFile[] = [];
    for (const runId of runIds) {
      const view = await loadRun(experimentDir, runId);
      views.push(view);
      runs.push({
        runId,
        createdAt: view.manifest.createdAt,
        runBody: renderRunPage(view),
      });
    }
    return {
      experimentId: EXPERIMENT_ID,
      runs,
      experimentBody: renderExperimentSection(views),
      overviewCard: renderOverviewCard(views),
    };
  },
};
