// -------------------------------------------------------------------------
// sema-tax site adapter
//
// Parses the sema-tax manifest and trial records with the experiment's own
// schemas, recomputes the tax-curve summary with the experiment's own
// summarizer (never a stored number), cross-checks it against the committed
// summary.json (failing the build on any disagreement), and renders the
// tax-curve run page and index columns.
// -------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  semaTaxResultManifestSchema,
  semaTaxTrialRecordSchema,
  type SemaTaxResultManifest,
  type SemaTaxTrialRecord,
} from "../../../experiments/sema-tax/src/schemas.js";
import {
  assertSummaryFaithful,
  type ExperimentAdapter,
  type LoadedExperiment,
  type PromoteManifest,
  type RunFile,
} from "../adapter-support.js";
import { buildPublicTrialsJsonl } from "../public-derivative.js";
import {
  renderSemaTaxCard,
  renderSemaTaxRunPage,
  renderSemaTaxSection,
  type SemaTaxRunView,
} from "../render-sema-tax.js";
import {
  aggregateSemaTax,
  compareSemaTaxSummary,
  type SemaTaxSummaryLike,
} from "../sema-tax-summary.js";

const EXPERIMENT_ID = "sema-tax";

function parseTrials(source: string): SemaTaxTrialRecord[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => semaTaxTrialRecordSchema.parse(JSON.parse(line)));
}

async function loadRun(
  experimentDir: string,
  runId: string,
): Promise<SemaTaxRunView> {
  const runDir = join(experimentDir, runId);
  const manifest: SemaTaxResultManifest = semaTaxResultManifestSchema.parse(
    JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")),
  );
  const summaryOnDisk: unknown = JSON.parse(
    await readFile(join(runDir, "summary.json"), "utf8"),
  );
  const records = parseTrials(
    await readFile(join(runDir, "trials.public.jsonl"), "utf8"),
  );

  const summary = aggregateSemaTax(records);
  assertSummaryFaithful(
    manifest.experimentId,
    runId,
    compareSemaTaxSummary(summary, summaryOnDisk as SemaTaxSummaryLike),
  );

  return { manifest, summary, dataDir: runId };
}

export const semaTaxAdapter: ExperimentAdapter = {
  experimentId: EXPERIMENT_ID,

  parseManifest(raw: unknown): PromoteManifest {
    return semaTaxResultManifestSchema.parse(raw);
  },

  redactTrials(source: string): string {
    return buildPublicTrialsJsonl<SemaTaxTrialRecord>(
      source,
      semaTaxTrialRecordSchema,
    );
  },

  async loadExperiment(
    experimentDir: string,
    runIds: readonly string[],
  ): Promise<LoadedExperiment> {
    const views: SemaTaxRunView[] = [];
    const runs: RunFile[] = [];
    for (const runId of runIds) {
      const view = await loadRun(experimentDir, runId);
      views.push(view);
      runs.push({
        runId,
        createdAt: view.manifest.createdAt,
        runBody: renderSemaTaxRunPage(view),
      });
    }
    return {
      experimentId: EXPERIMENT_ID,
      runs,
      experimentBody: renderSemaTaxSection(EXPERIMENT_ID, views),
      overviewCard: renderSemaTaxCard(EXPERIMENT_ID, views),
    };
  },
};
