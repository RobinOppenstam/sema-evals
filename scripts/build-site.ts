import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LoadedExperiment } from "./lib/experiment-adapter.js";
import { requireAdapter } from "./lib/experiment-adapter.js";
import {
  escapeHtml,
  page,
  renderOverviewBody,
  SITE_STYLE,
  type PageChrome,
} from "./lib/render.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPublicRoot = join(repoRoot, "results", "public");
const defaultOutputRoot = join(repoRoot, "site", "dist");

// Canonical origin of the published site (a GitHub Pages project site). Used
// only for the canonical <link> in the legacy redirect stubs; the meta refresh
// itself is relative, so the redirect works regardless of the deployment host.
const SITE_BASE_URL = "https://robinoppenstam.github.io/sema-evals";

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

// A plain redirect stub written at the pre-move (flat) run-page URL. Existing
// links to /runs/<runId>.html — including any already shared — meta-refresh to
// the new /<experimentId>/runs/<runId>.html location, with a canonical link and
// a visible fallback anchor for clients that ignore the refresh.
function redirectStub(experimentId: string, runId: string): string {
  const target = `../${experimentId}/runs/${runId}.html`;
  const canonical = `${SITE_BASE_URL}/${experimentId}/runs/${runId}.html`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<title>Moved — ${escapeHtml(experimentId)}/${escapeHtml(runId)}</title>
</head>
<body>
<p>This report has moved to <a href="${escapeHtml(target)}">${escapeHtml(experimentId)}/runs/${escapeHtml(runId)}.html</a>.</p>
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

/** Every file under `root`, as POSIX-separated paths relative to `root`, sorted. */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out.push(relative(root, full).split("\\").join("/"));
      }
    }
  }
  await walk(root);
  return out.sort();
}

async function copyDerivative(runDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const file of ["manifest.json", "summary.json", "trials.public.jsonl"]) {
    await writeFile(join(destDir, file), await readFile(join(runDir, file)));
  }
}

/** A redirect written from the pre-move run URL to its new location. */
export interface RedirectStub {
  /** Path of the stub, relative to the dist root (the old published URL). */
  from: string;
  /** Path it forwards to, relative to the dist root (the new run-page URL). */
  to: string;
}

export interface BuildResult {
  runCount: number;
  /** Experiment ids with promoted runs, in nav order. */
  experimentIds: string[];
  /** One redirect stub per pre-existing (flat) run-page URL. */
  redirects: RedirectStub[];
  /** Every generated file, relative to the dist root, sorted. */
  files: string[];
}

export interface BuildOptions {
  publicRoot?: string;
  outputRoot?: string;
}

/**
 * Build the static site into `outputRoot`. URL structure:
 *   - overview            /index.html
 *   - experiment page     /<experimentId>/index.html
 *   - run page            /<experimentId>/runs/<runId>.html
 *   - run artifacts       /<experimentId>/runs/<runId>/{manifest,summary,trials}
 *   - legacy redirect     /runs/<runId>.html  → new run-page URL
 *
 * Each experiment is dispatched through its registered site adapter, which owns
 * parsing, the recompute-and-cross-check, and all experiment-specific rendering.
 */
export async function buildSite(
  options: BuildOptions = {},
): Promise<BuildResult> {
  const publicRoot = options.publicRoot ?? defaultPublicRoot;
  const outputRoot = options.outputRoot ?? defaultOutputRoot;

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  // First pass: load every experiment that has promoted runs, so the nav list
  // (which every page carries) is fully known before any page is rendered.
  const loaded: {
    experimentId: string;
    experimentDir: string;
    result: LoadedExperiment;
  }[] = [];
  for (const experimentId of await listDirs(publicRoot)) {
    const experimentDir = join(publicRoot, experimentId);
    const runIds = await listDirs(experimentDir);
    if (runIds.length === 0) {
      continue;
    }
    const adapter = requireAdapter(experimentId);
    const result = await adapter.loadExperiment(experimentDir, runIds);
    loaded.push({ experimentId, experimentDir, result });
  }

  const navExperiments = loaded.map((entry) => entry.experimentId);
  const redirects: RedirectStub[] = [];
  let runCount = 0;

  // The pre-move run URLs lived flat under /runs; keep the directory for stubs.
  await mkdir(join(outputRoot, "runs"), { recursive: true });

  for (const { experimentId, experimentDir, result } of loaded) {
    const expOutDir = join(outputRoot, experimentId);
    await mkdir(join(expOutDir, "runs"), { recursive: true });

    // Per-experiment page: /<experimentId>/index.html (one level below root).
    const experimentChrome: PageChrome = {
      base: "../",
      experiments: navExperiments,
      current: { kind: "experiment", id: experimentId },
    };
    await writeFile(
      join(expOutDir, "index.html"),
      htmlDocument(
        `${experimentId} — sema-evals`,
        page(result.experimentBody, experimentChrome),
      ),
      "utf8",
    );

    for (const run of result.runs) {
      // Run page: /<experimentId>/runs/<runId>.html (two levels below root).
      const runChrome: PageChrome = {
        base: "../../",
        experiments: navExperiments,
        current: { kind: "experiment", id: experimentId },
      };
      await writeFile(
        join(expOutDir, "runs", `${run.runId}.html`),
        htmlDocument(
          `${experimentId} — ${run.runId}`,
          page(run.runBody, runChrome),
        ),
        "utf8",
      );
      // Artifacts stay next to their run page.
      await copyDerivative(
        join(experimentDir, run.runId),
        join(expOutDir, "runs", run.runId),
      );

      // Redirect stub at the pre-move URL so shared links do not break.
      await writeFile(
        join(outputRoot, "runs", `${run.runId}.html`),
        redirectStub(experimentId, run.runId),
        "utf8",
      );
      redirects.push({
        from: `runs/${run.runId}.html`,
        to: `${experimentId}/runs/${run.runId}.html`,
      });
      runCount += 1;
    }
  }

  // Overview: /index.html (root).
  const overviewChrome: PageChrome = {
    base: "",
    experiments: navExperiments,
    current: { kind: "overview" },
  };
  await writeFile(
    join(outputRoot, "index.html"),
    htmlDocument(
      "sema-evals public reports",
      page(
        renderOverviewBody(loaded.map((entry) => entry.result.overviewCard)),
        overviewChrome,
      ),
    ),
    "utf8",
  );

  const files = await listFiles(outputRoot);
  return { runCount, experimentIds: navExperiments, redirects, files };
}

async function main(): Promise<void> {
  const result = await buildSite();
  console.log(
    `Built ${result.runCount} run report(s) across ${result.experimentIds.length} experiment(s) ` +
      `(+${result.redirects.length} redirect stub(s)) into ${defaultOutputRoot}`,
  );
}

// Run the build only when invoked as a script; importing (e.g. from a test)
// must not trigger a build with side effects.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
