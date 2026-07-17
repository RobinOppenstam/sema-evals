import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FixtureReferenceProvider,
  SemaPythonReferenceProvider,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  executeMatrix,
  fingerprint,
  planPairedMatrix,
  sha256Text,
  type TrialProvenance,
} from "@sema-evals/core";
import { writeResultBundleWith } from "@sema-evals/reporters";

import { buildConditions } from "./conditions.js";
import { runForecastingTrial } from "./demo.js";
import { loadFixtureFile } from "./fixtures.js";
import { buildLeakageAuditDocument } from "./leakage.js";
import {
  forecastingResultManifestSchema,
  forecastingTrialRecordSchema,
  leakageAuditDocumentSchema,
} from "./schemas.js";
import { forecastingSummaryMarkdown, summarizeForecasting } from "./summary.js";
import {
  FORECASTING_SCORER_FINGERPRINT,
  FORECASTING_SCORER_VERSION,
} from "./scoring.js";

const EXPERIMENT_ID = "forecasting";
const FORECASTING_POLICY =
  "deterministic-forecasting-council-demo-v2-canonical-aggregation";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface CliOptions {
  mode: "deterministic-harness";
  fixturePath: string;
  outputRoot: string;
  orderSeed: number;
  seedCount: number;
  semanticBackend: "fixture" | "sema-python";
  semaPython: string;
}

function usage(): string {
  return [
    "Usage: pnpm experiment:forecasting -- [options]",
    "",
    "Options:",
    "  --mode <m>          deterministic-harness (only supported mode)",
    "  --fixtures <path>   YAML scenario fixture file",
    "  --output <path>     Result root directory",
    "  --order-seed <n>    Recorded randomization seed (default: 20260716)",
    "  --seeds <n>         Number of paired repetition seeds (default: 1)",
    "  --semantic-backend  fixture or sema-python (default: fixture)",
    "  --sema-python <cmd> Python executable with semahash installed",
    "  --help              Show this help",
    "",
    "Deterministic harness only. Model-pilot mode is future work (ADR 0017).",
  ].join("\n");
}

function nonnegativeInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a nonnegative integer.`);
  }
  return parsed;
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

function resolveFromRepoRoot(value: string): string {
  return /[\\/]/.test(value) ? resolve(REPO_ROOT, value) : value;
}

export function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    mode: "deterministic-harness",
    fixturePath: join(
      REPO_ROOT,
      "experiments/forecasting/fixtures/scenarios.yaml",
    ),
    outputRoot: join(REPO_ROOT, "results/forecasting"),
    orderSeed: 20_260_716,
    seedCount: 1,
    semanticBackend: "fixture",
    semaPython: resolveFromRepoRoot(process.env.SEMA_PYTHON ?? "python3"),
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--mode") {
      const mode = args[++index];
      if (mode !== "deterministic-harness") {
        throw new Error(
          `${argument} requires deterministic-harness; model-pilot is not implemented.`,
        );
      }
      options.mode = mode;
      continue;
    }
    if (argument === "--fixtures") {
      options.fixturePath = resolve(REPO_ROOT, args[++index] ?? "");
      continue;
    }
    if (argument === "--output") {
      options.outputRoot = resolve(REPO_ROOT, args[++index] ?? "");
      continue;
    }
    if (argument === "--order-seed") {
      options.orderSeed = nonnegativeInteger(args[++index], argument);
      continue;
    }
    if (argument === "--seeds") {
      options.seedCount = positiveInteger(args[++index], argument);
      continue;
    }
    if (argument === "--semantic-backend") {
      const backend = args[++index];
      if (backend !== "fixture" && backend !== "sema-python") {
        throw new Error(`${argument} requires fixture or sema-python.`);
      }
      options.semanticBackend = backend;
      continue;
    }
    if (argument === "--sema-python") {
      const command = args[++index];
      if (!command) {
        throw new Error(`${argument} requires a Python executable.`);
      }
      options.semaPython = resolveFromRepoRoot(command);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }

  return options;
}

function createReferenceProvider(
  options: CliOptions,
): SemanticReferenceProvider {
  if (options.semanticBackend === "sema-python") {
    return new SemaPythonReferenceProvider({
      pythonCommand: options.semaPython,
    });
  }
  return new FixtureReferenceProvider();
}

function gitRevision(): string {
  if (process.env.IMPLEMENTATION_COMMIT) {
    return process.env.IMPLEMENTATION_COMMIT;
  }
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirty ? `${revision}+dirty` : revision;
  } catch {
    return "working-tree";
  }
}

async function fileDigest(path: string): Promise<string> {
  try {
    return sha256Text(await readFile(path, "utf8"));
  } catch {
    return sha256Text("missing");
  }
}

function timestampId(date: Date): string {
  return date.toISOString().replaceAll(/[-:.]/g, "");
}

export async function runForecastingCli(
  args: readonly string[],
): Promise<string> {
  const options = parseArgs(args);

  const { fixtureDigest, fixtureSet, driftScenarioCount, cleanScenarioCount } =
    await loadFixtureFile(options.fixturePath);
  const conditions = buildConditions();

  const referenceProvider = createReferenceProvider(options);
  const semanticMetadata = await referenceProvider.metadata();
  const vocabularyRoot = process.env.SEMA_VOCABULARY_ROOT ?? "";
  const seeds = Array.from({ length: options.seedCount }, (_, index) => index);

  const promptDigest = fingerprint({
    experiment: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    policy: FORECASTING_POLICY,
  });

  const provenance: TrialProvenance = {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    fixtureDigest,
    implementationCommit: gitRevision(),
    dependencyLockDigest: await fileDigest(join(REPO_ROOT, "pnpm-lock.yaml")),
    promptDigest,
    semaVersion: semanticMetadata.semaVersion,
    canonicalizationVersion: semanticMetadata.canonicalizationVersion,
    vocabularyRoot,
    semanticBackend: semanticMetadata.backend,
    modelProvider: process.env.MODEL_PROVIDER ?? "deterministic",
    modelName: process.env.MODEL_NAME ?? "forecasting-council-demo-v1",
  };

  const cells = planPairedMatrix({
    experimentId: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    scenarios: fixtureSet.scenarios,
    scenarioId: (scenario) => scenario.id,
    conditions,
    seeds,
    orderSeed: options.orderSeed,
  });

  const records = await executeMatrix(cells, (cell) =>
    runForecastingTrial(cell, {
      experimentId: EXPERIMENT_ID,
      referenceProvider,
      vocabularyRoot,
      provenance,
    }),
  );

  const summary = summarizeForecasting(records, fixtureSet.scenarios);

  const createdAt = new Date();
  const runId = `${timestampId(createdAt)}-order-${options.orderSeed}`;
  const outputDirectory = join(options.outputRoot, runId);
  const protocolFingerprint = fingerprint({
    experiment: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    policy: FORECASTING_POLICY,
    conditions,
    aggregationInterpretation: "canonical-probability-format",
    scorer: FORECASTING_SCORER_FINGERPRINT,
  });
  const bundle = await writeResultBundleWith(
    outputDirectory,
    {
      artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      experimentId: EXPERIMENT_ID,
      runId,
      mode: "deterministic-harness" as const,
      evidenceClaim:
        "Validates the forecasting-council scaffold: synthetic Polymarket-style questions, controlled per-agent registry drift, corrupted aggregation under baseline, voluntary detection, enforced exclusion, Brier baselines (market prior + independent-agent average), the no-drift false-exclusion guard, leakage-audit gate, condition pairing, and bundle/summary reproduction. Scripted-agent outcomes are a construction, not evidence about language models, and not evidence about live prediction markets (ADR 0017).",
      createdAt: createdAt.toISOString(),
      orderSeed: options.orderSeed,
      seeds,
      conditions,
      scenarioCount: fixtureSet.scenarios.length,
      driftScenarioCount,
      cleanScenarioCount,
      trialCount: records.length,
      fixtureDigest,
      leakageAuditPassed: summary.leakageAuditPassed,
      scorer: {
        version: FORECASTING_SCORER_VERSION,
        fingerprint: FORECASTING_SCORER_FINGERPRINT,
      },
      protocolFingerprint,
      runConfiguration: {
        mode: "deterministic-harness" as const,
        seeds,
        orderSeed: options.orderSeed,
        semanticBackend: options.semanticBackend,
        policy: FORECASTING_POLICY,
        aggregationInterpretation: "canonical-probability-format" as const,
      },
      provenance,
    },
    records,
    {
      manifestSchema: forecastingResultManifestSchema,
      recordSchema: forecastingTrialRecordSchema,
      summarize: (trialRecords) =>
        summarizeForecasting(trialRecords, fixtureSet.scenarios),
      renderMarkdown: forecastingSummaryMarkdown,
    },
  );

  const leakageDocument = buildLeakageAuditDocument(fixtureSet.scenarios);
  const leakagePath = join(bundle.directory, "leakage-audit.json");
  await writeFile(
    leakagePath,
    `${JSON.stringify(leakageAuditDocumentSchema.parse(leakageDocument), null, 2)}\n`,
    "utf8",
  );

  if (!summary.leakageAuditPassed) {
    throw new Error(
      `Leakage audit gate failed; failed result bundle preserved at ${bundle.directory}: ${summary.leakageAuditFailures.join("; ")}`,
    );
  }

  console.log(
    `Forecasting council demo completed: ${summary.trialCount} trials.`,
  );
  console.log(
    `Semantic backend: ${semanticMetadata.backend} (${semanticMetadata.semaVersion}, ${semanticMetadata.canonicalizationVersion})`,
  );
  console.log(`Leakage audit gate: PASSED`);
  console.log(`Result bundle: ${bundle.directory}`);
  for (const condition of summary.conditions) {
    console.log(
      `${condition.condition.padEnd(21)} ` +
        `corrupted=${(condition.corruptedAggregationRate * 100).toFixed(0)}% ` +
        `detected=${(condition.detectionRate * 100).toFixed(0)}% ` +
        `correctExcl=${condition.correctExclusions} falseExcl=${condition.falseExclusions}`,
    );
  }
  return bundle.directory;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  runForecastingCli(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
