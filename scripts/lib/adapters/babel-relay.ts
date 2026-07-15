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
  analyzeArm,
  type ModelAnalysis,
} from "../../../experiments/babel-relay/src/confirmatory-analysis.js";
import {
  aggregateTrials,
  compareWithSummary,
  type SummaryLike,
} from "../aggregate.js";
import {
  assertAnalysisFaithful,
  assertSummaryFaithful,
  type ExperimentAdapter,
  type LoadedExperiment,
  type PromoteManifest,
  type RunFile,
} from "../adapter-support.js";
import { crossCheckAnalysis } from "../confirmatory-crosscheck.js";
import { buildPublicTrialsJsonl } from "../public-derivative.js";
import {
  renderBabelRelayCard,
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

/** Read a bundle's optional analysis.json, or undefined when it ships none. */
async function readOptionalAnalysis(runDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(runDir, "analysis.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function loadRun(
  experimentDir: string,
  runId: string,
): Promise<{
  manifest: ResultManifest;
  aggregate: RunView["aggregate"];
  records: TrialRecord[];
}> {
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

  // For a confirmatory run, if the bundle also ships an analysis JSON, recompute
  // the registered analysis from the public trials and cross-check — the site
  // never trusts a stored analysis (same policy as the summary recompute).
  if (manifest.mode === "confirmatory") {
    const shipped = await readOptionalAnalysis(runDir);
    if (shipped !== undefined) {
      const recomputed: ModelAnalysis = analyzeArm({
        arm: manifest.provenance.modelName,
        mode: manifest.mode,
        trials: records,
      });
      assertAnalysisFaithful(
        manifest.experimentId,
        runId,
        crossCheckAnalysis(recomputed, shipped, manifest.provenance.modelName),
      );
    }
  }

  return { manifest, aggregate, records };
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
      const { manifest, aggregate, records } = await loadRun(
        experimentDir,
        runId,
      );
      // Attach parsed records only for confirmatory runs, whose pages recompute
      // the preregistered analysis from them; other modes never read them.
      const view: RunView =
        manifest.mode === "confirmatory"
          ? { manifest, aggregate, dataDir: runId, records }
          : { manifest, aggregate, dataDir: runId };
      views.push(view);
      runs.push({
        runId,
        createdAt: manifest.createdAt,
        runBody: renderRunPage(view),
      });
    }
    return {
      experimentId: EXPERIMENT_ID,
      runs,
      experimentBody: renderBabelRelaySection(EXPERIMENT_ID, views),
      overviewCard: renderBabelRelayCard(EXPERIMENT_ID, views),
    };
  },
};
