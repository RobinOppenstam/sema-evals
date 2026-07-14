import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resultManifestSchema,
  trialRecordSchema,
  type TrialRecord,
} from "../packages/core/src/schemas.js";

import {
  aggregateTrials,
  compareWithSummary,
  type SummaryLike,
} from "./lib/aggregate.js";
import {
  renderIndex,
  renderRunPage,
  SITE_STYLE,
  escapeHtml,
  type RunView,
} from "./lib/render.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = join(repoRoot, "results", "public");
const outputRoot = join(repoRoot, "site", "dist");

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${SITE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

async function listDirs(path: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function parseTrials(source: string): TrialRecord[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => trialRecordSchema.parse(JSON.parse(line)));
}

interface LoadedRun {
  view: RunView;
  runDir: string;
}

async function loadRun(
  experimentId: string,
  runId: string,
): Promise<LoadedRun> {
  const runDir = join(publicRoot, experimentId, runId);
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
  const warnings = compareWithSummary(aggregate, summary as SummaryLike);
  if (warnings.length > 0) {
    console.warn(
      `[build-site] ${experimentId}/${runId}: summary.json disagrees with recomputed aggregates:`,
    );
    for (const warning of warnings) {
      console.warn(`  - ${warning}`);
    }
  }

  return {
    view: { manifest, aggregate, dataDir: runId },
    runDir,
  };
}

async function copyDerivative(runDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const file of ["manifest.json", "summary.json", "trials.public.jsonl"]) {
    await writeFile(join(destDir, file), await readFile(join(runDir, file)));
  }
}

async function main(): Promise<void> {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(join(outputRoot, "runs"), { recursive: true });

  const runs: RunView[] = [];
  const experiments = await listDirs(publicRoot);
  for (const experimentId of experiments) {
    const runIds = await listDirs(join(publicRoot, experimentId));
    for (const runId of runIds) {
      const { view, runDir } = await loadRun(experimentId, runId);
      runs.push(view);

      const runPage = renderRunPage(view);
      await writeFile(
        join(outputRoot, "runs", `${runId}.html`),
        htmlDocument(`${experimentId} — ${runId}`, runPage),
        "utf8",
      );
      await copyDerivative(runDir, join(outputRoot, "runs", runId));
    }
  }

  await writeFile(
    join(outputRoot, "index.html"),
    htmlDocument("sema-evals public reports", renderIndex(runs)),
    "utf8",
  );

  console.log(
    `Built ${runs.length} run report(s) from ${experiments.length} experiment(s) into ${outputRoot}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
