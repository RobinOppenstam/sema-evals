import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requireAdapter } from "./lib/experiment-adapter.js";
import { PUBLIC_DERIVATIVE_RULES } from "./lib/public-derivative.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  bundleDir: string;
  force: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const positional: string[] = [];
  let force = false;
  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
    } else if (arg === "--") {
      continue;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const bundleDir = positional[0];
  if (bundleDir === undefined) {
    throw new Error(
      "Usage: pnpm report:promote -- <bundle-dir> [--force]\n" +
        "  <bundle-dir> must contain manifest.json, summary.json, and trials.jsonl.",
    );
  }
  return { bundleDir, force };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { bundleDir, force } = parseArgs(process.argv.slice(2));
  const sourceDir = resolve(bundleDir);

  const manifestRaw = await readFile(join(sourceDir, "manifest.json"), "utf8");
  const summaryRaw = await readFile(join(sourceDir, "summary.json"), "utf8");
  const trialsRaw = await readFile(join(sourceDir, "trials.jsonl"), "utf8");

  // Peek the experiment id, then dispatch to that experiment's adapter for the
  // manifest parse gate and the trial redaction policy.
  const manifestJson: unknown = JSON.parse(manifestRaw);
  const experimentId = (manifestJson as { experimentId?: unknown })
    .experimentId;
  if (typeof experimentId !== "string") {
    throw new Error("manifest.json is missing a string experimentId.");
  }
  const adapter = requireAdapter(experimentId);

  // Validate the manifest before promoting anything.
  const manifest = adapter.parseManifest(manifestJson);

  const destDir = join(
    repoRoot,
    "results",
    "public",
    manifest.experimentId,
    manifest.runId,
  );

  if (await pathExists(destDir)) {
    if (!force) {
      throw new Error(
        `Refusing to overwrite existing promoted run at ${destDir}. Pass --force to replace it.`,
      );
    }
    await rm(destDir, { recursive: true, force: true });
  }

  // Build the redacted public derivative before writing anything, so a failure
  // leaves no partial promotion behind.
  const publicTrials = adapter.redactTrials(trialsRaw);

  await mkdir(destDir, { recursive: true });

  const promotedMd = [
    `# Promoted report: ${manifest.experimentId} / ${manifest.runId}`,
    "",
    `- Promoted on: ${manifest.createdAt.slice(0, 10)} (run creation date; promotion is deterministic and clock-free)`,
    `- Source bundle: \`${bundleDir}\``,
    `- Mode: ${manifest.mode}`,
    `- Evidence claim: ${manifest.evidenceClaim}`,
    "",
    "## Public derivative rules",
    "",
    ...PUBLIC_DERIVATIVE_RULES.map((rule) => `- ${rule}`),
    "",
  ].join("\n");

  await Promise.all([
    writeFile(join(destDir, "manifest.json"), manifestRaw, "utf8"),
    writeFile(join(destDir, "summary.json"), summaryRaw, "utf8"),
    writeFile(join(destDir, "trials.public.jsonl"), publicTrials, "utf8"),
    writeFile(join(destDir, "PROMOTED.md"), promotedMd, "utf8"),
  ]);

  console.log(
    `Promoted ${manifest.experimentId}/${manifest.runId} to ${destDir}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
