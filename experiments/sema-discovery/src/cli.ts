import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FixtureReferenceProvider,
  SemaPythonReferenceProvider,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  executeMatrix,
  fingerprint,
  planPairedMatrix,
  sha256Text,
  type TrialProvenance,
} from "@sema-evals/core";
import { createResultJournalWith } from "@sema-evals/reporters";

import { buildConditions } from "./conditions.js";
import { loadDiscoveryFixtures } from "./fixtures.js";
import { RANKER_FINGERPRINT, SEARCH_PARAMETERS } from "./search.js";
import {
  SEMA_DISCOVERY_PROTOCOL_VERSION,
  SEMA_DISCOVERY_SCORER_VERSION,
  semaDiscoveryManifestSchema,
  semaDiscoveryTrialRecordSchema,
  type SemaDiscoveryManifest,
} from "./schemas.js";
import {
  semaDiscoverySummaryMarkdown,
  summarizeSemaDiscovery,
} from "./summary.js";
import { runSemaDiscoveryTrial } from "./trial.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_FIXTURES = join(
  REPO_ROOT,
  "experiments/sema-discovery/fixtures/catalog.yaml",
);

interface CliOptions {
  fixturePath: string;
  outputRoot: string;
  orderSeed: number;
  seedCount: number;
  semanticBackend: "fixture" | "sema-python";
  semaPython: string;
}

function usage(): string {
  return [
    "Usage: pnpm experiment:sema-discovery -- [options]",
    "",
    "Options:",
    "  --fixtures <path>   Discovery catalog fixture",
    "  --output <path>     Result root directory",
    "  --order-seed <n>    Randomization seed (default: 20260717)",
    "  --seeds <n>         Paired repetitions (default: 1)",
    "  --semantic-backend  fixture or sema-python (default: fixture)",
    "  --sema-python <cmd> Python executable with semahash installed",
    "  --help              Show this help",
    "",
    "Deterministic/fake scaffold only. No live model or network calls.",
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

export function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    fixturePath: DEFAULT_FIXTURES,
    outputRoot: join(REPO_ROOT, "results/sema-discovery"),
    orderSeed: 20_260_717,
    seedCount: 1,
    semanticBackend: "fixture",
    semaPython: process.env.SEMA_PYTHON ?? "python3",
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
      options.semaPython = /[\\/]/.test(command)
        ? resolve(REPO_ROOT, command)
        : command;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }
  return options;
}

function createReferenceProvider(
  options: CliOptions,
): SemanticReferenceProvider {
  return options.semanticBackend === "sema-python"
    ? new SemaPythonReferenceProvider({ pythonCommand: options.semaPython })
    : new FixtureReferenceProvider();
}

function gitRevision(): string {
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

export async function runSemaDiscoveryCli(
  args: readonly string[],
): Promise<string> {
  const options = parseArgs(args);
  const { fixtureSet, fixtureDigest, catalogFingerprint } =
    await loadDiscoveryFixtures(options.fixturePath);
  const referenceProvider = createReferenceProvider(options);
  const metadata = await referenceProvider.metadata();
  const conditions = buildConditions();
  const seeds = Array.from({ length: options.seedCount }, (_, index) => index);
  const provenance: TrialProvenance = {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    protocolVersion: SEMA_DISCOVERY_PROTOCOL_VERSION,
    fixtureDigest,
    implementationCommit: gitRevision(),
    dependencyLockDigest: await fileDigest(join(REPO_ROOT, "pnpm-lock.yaml")),
    promptDigest: fingerprint({
      policy: "deterministic-search-select-resolve-execute-reuse-v1",
      searchParameters: SEARCH_PARAMETERS,
    }),
    semaVersion: metadata.semaVersion,
    canonicalizationVersion: metadata.canonicalizationVersion,
    vocabularyRoot: catalogFingerprint,
    semanticBackend: metadata.backend,
    modelProvider: "deterministic",
    modelName: "scripted-discovery-executor-v1",
  };
  const cells = planPairedMatrix({
    experimentId: "sema-discovery",
    protocolVersion: SEMA_DISCOVERY_PROTOCOL_VERSION,
    scenarios: fixtureSet.scenarios,
    scenarioId: (scenario) => scenario.id,
    conditions,
    seeds,
    orderSeed: options.orderSeed,
  });
  const scorer: SemaDiscoveryManifest["scorer"] = {
    version: SEMA_DISCOVERY_SCORER_VERSION,
    fingerprint: fingerprint({
      version: SEMA_DISCOVERY_SCORER_VERSION,
      success:
        "correct-selection-and-complete-dependencies-and-two-passing-executions",
    }),
  };
  const searchParameters: SemaDiscoveryManifest["searchParameters"] = {
    ...SEARCH_PARAMETERS,
    queryFields: [...SEARCH_PARAMETERS.queryFields],
    patternFields: [...SEARCH_PARAMETERS.patternFields],
  };
  const protocolFingerprint = fingerprint({
    protocolVersion: SEMA_DISCOVERY_PROTOCOL_VERSION,
    conditions,
    searchParameters,
    scorer,
    sessionReset: "before-every-trial",
    discoveryReuseScope: "within-trial-only",
  });
  const createdAt = new Date();
  const runId = `${timestampId(createdAt)}-order-${options.orderSeed}`;
  const outputDirectory = join(options.outputRoot, runId);
  const manifest: SemaDiscoveryManifest = {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    protocolVersion: SEMA_DISCOVERY_PROTOCOL_VERSION,
    experimentId: "sema-discovery",
    runId,
    mode: "deterministic-harness",
    evidenceClaim:
      "Deterministic mechanism/scaffold validation of search, selection, dependency resolution, execution, and within-session reuse. Scripted outcomes are constructed and are not evidence that models discover useful patterns or that a library improves workflow performance.",
    createdAt: createdAt.toISOString(),
    orderSeed: options.orderSeed,
    seeds,
    conditions,
    scenarioCount: fixtureSet.scenarios.length,
    trialCount: cells.length,
    fixtureDigest,
    catalogFingerprint,
    rankerFingerprint: RANKER_FINGERPRINT,
    searchParameters,
    scorer,
    protocolFingerprint,
    runConfiguration: {
      mode: "deterministic-harness",
      orderSeed: options.orderSeed,
      repetitionCount: options.seedCount,
      semanticBackend: metadata.backend,
      sessionReset: "before-every-trial",
      discoveryReuseScope: "within-trial-only",
    },
    provenance,
  };
  const journal = await createResultJournalWith(outputDirectory, manifest, {
    manifestSchema: semaDiscoveryManifestSchema,
    recordSchema: semaDiscoveryTrialRecordSchema,
    summarize: summarizeSemaDiscovery,
    renderMarkdown: semaDiscoverySummaryMarkdown,
  });
  try {
    const records = await executeMatrix(
      cells,
      (cell) =>
        runSemaDiscoveryTrial(cell, {
          catalog: fixtureSet.catalog,
          referenceProvider,
          provenance,
        }),
      { onComplete: (record) => journal.append(record) },
    );
    await journal.finalize(records);
  } catch (error) {
    await journal.fail(error);
    throw error;
  }
  return outputDirectory;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  runSemaDiscoveryCli(process.argv.slice(2))
    .then((directory) => console.log(`Result bundle: ${directory}`))
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      process.exitCode = 1;
    });
}
