// -------------------------------------------------------------------------
// babel-relay site adapter
//
// Wraps the original relay-shaped load + render path behind the experiment
// adapter contract. Output is byte-identical to the pre-adapter build: the same
// core schemas parse the manifest and trials, the same aggregate is recomputed
// and cross-checked, and the same run-page / index-section renderers run.
// -------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  resultManifestSchema,
  trialRecordSchema,
  type ResultManifest,
  type TrialRecord,
} from "../../../packages/core/src/schemas.js";
import {
  aggregateTrials,
  compareWithSummary,
  type SummaryLike,
} from "../aggregate.js";
import {
  assertSummaryFaithful,
  type ExperimentAdapter,
  type LoadedExperiment,
  type PromoteManifest,
  type RunFile,
} from "../adapter-support.js";
import { buildPublicTrialsJsonl } from "../public-derivative.js";
import {
  renderBabelRelaySection,
  renderRunPage,
  type RunView,
} from "../render.js";

const EXPERIMENT_ID = "babel-relay";

function parseTrials(source: string): TrialRecord[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => trialRecordSchema.parse(JSON.parse(line)));
}

async function loadRun(
  experimentDir: string,
  runId: string,
): Promise<{ manifest: ResultManifest; aggregate: RunView["aggregate"] }> {
  const runDir = join(experimentDir, runId);
  const manifest = resultManifestSchema.parse(
    JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")),
  );
  const summary: unknown = JSON.parse(
    await readFile(join(runDir, "summary.json"), "utf8"),
  );
  const records = parseTrials(
    await readFile(join(runDir, "trials.public.jsonl"), "utf8"),
  );

  const aggregate = aggregateTrials(records);
  assertSummaryFaithful(
    manifest.experimentId,
    runId,
    compareWithSummary(aggregate, summary as SummaryLike),
  );

  return { manifest, aggregate };
}

export const babelRelayAdapter: ExperimentAdapter = {
  experimentId: EXPERIMENT_ID,

  parseManifest(raw: unknown): PromoteManifest {
    return resultManifestSchema.parse(raw);
  },

  redactTrials(source: string): string {
    return buildPublicTrialsJsonl<TrialRecord>(source, trialRecordSchema);
  },

  async loadExperiment(
    experimentDir: string,
    runIds: readonly string[],
  ): Promise<LoadedExperiment> {
    const views: RunView[] = [];
    const runs: RunFile[] = [];
    for (const runId of runIds) {
      const { manifest, aggregate } = await loadRun(experimentDir, runId);
      const view: RunView = { manifest, aggregate, dataDir: runId };
      views.push(view);
      runs.push({
        runId,
        createdAt: manifest.createdAt,
        runPage: renderRunPage(view),
      });
    }
    return {
      experimentId: EXPERIMENT_ID,
      runs,
      indexSection: renderBabelRelaySection(EXPERIMENT_ID, views),
    };
  },
};
