import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requireAdapter } from "./lib/experiment-adapter.js";
import { renderIndexShell, SITE_STYLE, escapeHtml } from "./lib/render.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = join(repoRoot, "results", "public");
const outputRoot = join(repoRoot, "site", "dist");

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%232a78d6'/%3E%3Cpath d='M4 11V7m4 4V4m4 7V6' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E">
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

async function copyDerivative(runDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const file of ["manifest.json", "summary.json", "trials.public.jsonl"]) {
    await writeFile(join(destDir, file), await readFile(join(runDir, file)));
  }
}

async function main(): Promise<void> {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(join(outputRoot, "runs"), { recursive: true });

  const experiments = await listDirs(publicRoot);
  const sections: string[] = [];
  let runCount = 0;

  for (const experimentId of experiments) {
    const experimentDir = join(publicRoot, experimentId);
    const runIds = await listDirs(experimentDir);
    if (runIds.length === 0) {
      continue;
    }
    // Dispatch every experiment through its registered site adapter: the adapter
    // owns parsing, the recompute-and-cross-check, and all experiment-specific
    // rendering. An unregistered experiment fails the build loudly.
    const adapter = requireAdapter(experimentId);
    const loaded = await adapter.loadExperiment(experimentDir, runIds);

    for (const run of loaded.runs) {
      await writeFile(
        join(outputRoot, "runs", `${run.runId}.html`),
        htmlDocument(`${experimentId} — ${run.runId}`, run.runPage),
        "utf8",
      );
      await copyDerivative(
        join(experimentDir, run.runId),
        join(outputRoot, "runs", run.runId),
      );
      runCount += 1;
    }
    sections.push(loaded.indexSection);
  }

  await writeFile(
    join(outputRoot, "index.html"),
    htmlDocument("sema-evals public reports", renderIndexShell(sections)),
    "utf8",
  );

  console.log(
    `Built ${runCount} run report(s) from ${experiments.length} experiment(s) into ${outputRoot}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
