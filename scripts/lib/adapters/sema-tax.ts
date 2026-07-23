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
  semaTaxSizeReuseResultManifestSchema,
  semaTaxSizeReuseTrialRecordSchema,
  type SemaTaxSizeReuseResultManifest,
  type SemaTaxSizeReuseTrialRecord,
} from "../../../experiments/sema-tax/src/size-reuse/schemas.js";
import {
  summarizeSizeReuse,
  type SizeReuseSummary,
} from "../../../experiments/sema-tax/src/size-reuse/summary.js";
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
  renderSemaTaxSizeReuseRunPage,
  renderSemaTaxSizeReuseSection,
  type SemaTaxSizeReuseRunView,
} from "../render-sema-tax-size-reuse.js";
import { renderExperimentCard } from "../render.js";
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

async function loadCurveRun(
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

function compareSizeReuseSummary(
  recomputed: SizeReuseSummary,
  stored: unknown,
): string[] {
  return JSON.stringify(recomputed) === JSON.stringify(stored)
    ? []
    : ["summary.json is not byte-equivalent to the recomputed summary object"];
}

async function loadSizeReuseRun(
  experimentDir: string,
  runId: string,
): Promise<SemaTaxSizeReuseRunView> {
  const runDir = join(experimentDir, runId);
  const manifest: SemaTaxSizeReuseResultManifest =
    semaTaxSizeReuseResultManifestSchema.parse(
      JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")),
    );
  const summaryOnDisk: unknown = JSON.parse(
    await readFile(join(runDir, "summary.json"), "utf8"),
  );
  const records = (await readFile(join(runDir, "trials.public.jsonl"), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => semaTaxSizeReuseTrialRecordSchema.parse(JSON.parse(line)));
  const summary = summarizeSizeReuse(records);
  assertSummaryFaithful(
    manifest.experimentId,
    runId,
    compareSizeReuseSummary(summary, summaryOnDisk),
  );
  return { manifest, summary };
}

function isSizeReuseManifest(
  raw: unknown,
): raw is { readonly arm: "size-reuse" } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "arm" in raw &&
    raw.arm === "size-reuse"
  );
}

export const semaTaxAdapter: ExperimentAdapter = {
  experimentId: EXPERIMENT_ID,

  parseManifest(raw: unknown): PromoteManifest {
    return isSizeReuseManifest(raw)
      ? semaTaxSizeReuseResultManifestSchema.parse(raw)
      : semaTaxResultManifestSchema.parse(raw);
  },

  redactTrials(source: string): string {
    const first = source
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (
      first !== undefined &&
      semaTaxSizeReuseTrialRecordSchema.safeParse(JSON.parse(first)).success
    ) {
      return buildPublicTrialsJsonl<SemaTaxSizeReuseTrialRecord>(
        source,
        semaTaxSizeReuseTrialRecordSchema,
      );
    }
    return buildPublicTrialsJsonl<SemaTaxTrialRecord>(
      source,
      semaTaxTrialRecordSchema,
    );
  },

  async loadExperiment(
    experimentDir: string,
    runIds: readonly string[],
  ): Promise<LoadedExperiment> {
    const curveViews: SemaTaxRunView[] = [];
    const sizeReuseViews: SemaTaxSizeReuseRunView[] = [];
    const runs: RunFile[] = [];
    for (const runId of runIds) {
      const rawManifest: unknown = JSON.parse(
        await readFile(join(experimentDir, runId, "manifest.json"), "utf8"),
      );
      if (isSizeReuseManifest(rawManifest)) {
        const view = await loadSizeReuseRun(experimentDir, runId);
        sizeReuseViews.push(view);
        runs.push({
          runId,
          createdAt: view.manifest.createdAt,
          runBody: renderSemaTaxSizeReuseRunPage(view),
        });
        continue;
      }
      const view = await loadCurveRun(experimentDir, runId);
      curveViews.push(view);
      runs.push({
        runId,
        createdAt: view.manifest.createdAt,
        runBody: renderSemaTaxRunPage(view),
      });
    }
    const allManifests = [
      ...curveViews.map((view) => view.manifest),
      ...sizeReuseViews.map((view) => view.manifest),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = allManifests[0];
    const latestSizeReuse = sizeReuseViews
      .slice()
      .sort((a, b) =>
        b.manifest.createdAt.localeCompare(a.manifest.createdAt),
      )[0];
    const latestCurve = curveViews
      .slice()
      .sort((a, b) =>
        b.manifest.createdAt.localeCompare(a.manifest.createdAt),
      )[0];
    const byteWins =
      latestSizeReuse?.summary.crossings.filter(
        (crossing) => crossing.contentBeatsProseBytes,
      ).length ?? 0;
    const crossingCount = latestSizeReuse?.summary.crossings.length ?? 0;
    const fullCoverage =
      latestCurve?.summary.conditions.filter(
        (condition) => condition.patternCount === 16,
      ) ?? [];
    const bestFullCoverage =
      fullCoverage.length === 0
        ? null
        : Math.max(...fullCoverage.map((condition) => condition.meanScore));
    const scorePerK = latestCurve?.summary.conditions.map(
      (condition) => condition.scorePerKToken,
    );
    const scorePerKRange =
      scorePerK === undefined || scorePerK.length === 0
        ? null
        : [Math.min(...scorePerK), Math.max(...scorePerK)];
    const curveHeadline =
      bestFullCoverage === null || scorePerKRange === null
        ? ""
        : `; latest curve best full-coverage score <span class="tnum">${bestFullCoverage.toFixed(3)}</span>, score/1k tok <span class="tnum">${scorePerKRange[0]?.toFixed(4)}&ndash;${scorePerKRange[1]?.toFixed(4)}</span>`;
    return {
      experimentId: EXPERIMENT_ID,
      runs,
      experimentBody:
        renderSemaTaxSection(EXPERIMENT_ID, curveViews) +
        renderSemaTaxSizeReuseSection(sizeReuseViews),
      overviewCard:
        latestSizeReuse === undefined
          ? renderSemaTaxCard(EXPERIMENT_ID, curveViews)
          : renderExperimentCard({
              experimentId: EXPERIMENT_ID,
              lede: "Token, byte, and reuse costs of carrying semantic patterns.",
              runCount: allManifests.length,
              latestDate: latest?.createdAt.slice(0, 10) ?? "—",
              models: allManifests.map(
                (manifest) => manifest.provenance.modelName,
              ),
              headlineHtml: `Latest size/reuse arm &mdash; content beats prose bytes in <span class="tnum">${byteWins}/${crossingCount}</span> cells${curveHeadline}`,
            }),
    };
  },
};
