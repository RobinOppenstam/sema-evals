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
  PROTOCOL_VERSION,
  executeMatrix,
  fingerprint,
  planPairedMatrix,
  sha256Text,
  type TrialProvenance,
} from "@sema-evals/core";
import { writeResultBundleWith } from "@sema-evals/reporters";

import { buildConditions } from "./conditions.js";
import { loadCannedFindings, loadCases } from "./fixtures.js";
import { detectFoundry } from "./foundry.js";
import { assertNoCardLeakage, loadPatternCards } from "./leakage.js";
import {
  securityResultManifestSchema,
  securityTrialRecordSchema,
} from "./schemas.js";
import { SECURITY_SCORER_VERSION } from "./scorer.js";
import { securitySummaryMarkdown, summarizeSecurity } from "./summary.js";
import { runSecurityTrial } from "./trial.js";

const EXPERIMENT_ID = "security";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_CASES = join(REPO_ROOT, "experiments/security/fixtures/cases");
const DEFAULT_CARDS = join(
  REPO_ROOT,
  "experiments/security/vocabulary/sema-sec",
);
const DEFAULT_CANNED = join(
  REPO_ROOT,
  "experiments/security/fixtures/canned-findings.json",
);
const DEFAULT_FP_BUDGET = 1;

interface CliOptions {
  mode: "instrumentation";
  casesDir: string;
  cardsDir: string;
  cannedPath: string;
  outputRoot: string;
  orderSeed: number;
  seedCount: number;
  fpBudget: number;
  semanticBackend: "fixture" | "sema-python";
  semaPython: string;
  withFoundry: boolean;
}

function usage(): string {
  return [
    "Usage: pnpm experiment:security -- [options]",
    "",
    "Instrumentation harness only. Model-pilot mode is future work (ADR 0014);",
    "no providers are wired in this experiment.",
    "",
    "Options:",
    "  --mode <m>            instrumentation (default; only supported mode)",
    "  --cases <path>        Directory of case fixtures",
    "  --cards <path>        sema-sec vocabulary directory",
    "  --canned <path>       Canned auditor findings JSON",
    "  --output <path>       Result root directory",
    "  --order-seed <n>      Recorded randomization seed (default: 20260716)",
    "  --seeds <n>           Number of paired repetition seeds (default: 1)",
    "  --repetitions <n>     Alias for --seeds",
    "  --fp-budget <n>       Max false positives per case (default: 1)",
    "  --semantic-backend    fixture or sema-python (default: fixture)",
    "  --sema-python <cmd>   Python executable with semahash installed",
    "  --with-foundry        Attempt optional Foundry PoC checks (no-op if absent)",
    "  --help                Show this help",
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
    mode: "instrumentation",
    casesDir: DEFAULT_CASES,
    cardsDir: DEFAULT_CARDS,
    cannedPath: DEFAULT_CANNED,
    outputRoot: join(REPO_ROOT, "results/security"),
    orderSeed: 20_260_716,
    seedCount: 1,
    fpBudget: DEFAULT_FP_BUDGET,
    semanticBackend: "fixture",
    semaPython: resolveFromRepoRoot(process.env.SEMA_PYTHON ?? "python3"),
    withFoundry: false,
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
      if (mode !== "instrumentation") {
        throw new Error(
          `${argument} requires instrumentation (model-pilot is future work).`,
        );
      }
      options.mode = mode;
      continue;
    }
    if (argument === "--cases") {
      options.casesDir = resolve(REPO_ROOT, args[++index] ?? "");
      continue;
    }
    if (argument === "--cards") {
      options.cardsDir = resolve(REPO_ROOT, args[++index] ?? "");
      continue;
    }
    if (argument === "--canned") {
      options.cannedPath = resolve(REPO_ROOT, args[++index] ?? "");
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
    if (argument === "--seeds" || argument === "--repetitions") {
      options.seedCount = positiveInteger(args[++index], argument);
      continue;
    }
    if (argument === "--fp-budget") {
      options.fpBudget = nonnegativeInteger(args[++index], argument);
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
    if (argument === "--with-foundry") {
      options.withFoundry = true;
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const loaded = await loadCases(options.casesDir);
  const cardSet = await loadPatternCards(options.cardsDir);
  assertNoCardLeakage(
    cardSet.cards,
    loaded.cases.map((entry) => entry.meta),
  );
  const canned = await loadCannedFindings(options.cannedPath);
  const conditions = buildConditions();
  const foundry = await detectFoundry(options.withFoundry);

  const referenceProvider = createReferenceProvider(options);
  const semanticMetadata = await referenceProvider.metadata();
  const seeds = Array.from({ length: options.seedCount }, (_, index) => index);

  const promptDigest = fingerprint({
    experiment: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    policy: "security-instrumentation-v1",
    scorerVersion: SECURITY_SCORER_VERSION,
  });

  const provenance: TrialProvenance = {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    fixtureDigest: loaded.fixtureDigest,
    implementationCommit: gitRevision(),
    dependencyLockDigest: await fileDigest(join(REPO_ROOT, "pnpm-lock.yaml")),
    promptDigest,
    semaVersion: semanticMetadata.semaVersion,
    canonicalizationVersion: semanticMetadata.canonicalizationVersion,
    vocabularyRoot: process.env.SEMA_VOCABULARY_ROOT ?? options.cardsDir,
    semanticBackend: semanticMetadata.backend,
    modelProvider: process.env.MODEL_PROVIDER ?? "deterministic",
    modelName: process.env.MODEL_NAME ?? "security-scripted-auditor-v1",
  };

  const cells = planPairedMatrix({
    experimentId: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    scenarios: loaded.cases,
    scenarioId: (scenario) => scenario.meta.id,
    conditions,
    seeds,
    orderSeed: options.orderSeed,
  });

  const records = await executeMatrix(cells, (cell) =>
    runSecurityTrial(cell, {
      experimentId: EXPERIMENT_ID,
      referenceProvider,
      cards: cardSet.cards,
      cannedEntries: canned.entries,
      provenance,
      fpBudget: options.fpBudget,
    }),
  );

  const createdAt = new Date();
  const runId = `${timestampId(createdAt)}-order-${options.orderSeed}`;
  const outputDirectory = join(options.outputRoot, runId);
  const bundle = await writeResultBundleWith(
    outputDirectory,
    {
      artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      experimentId: EXPERIMENT_ID,
      runId,
      mode: "instrumentation" as const,
      evidenceClaim:
        "Validates the security fixture catalog, train/heldout leakage guard, condition ladder, deterministic scorer, enforced-decision gate, randomization, and bundle/summary reproduction. Scripted-auditor outcomes are a construction, not evidence about language models (ADR 0014).",
      createdAt: createdAt.toISOString(),
      orderSeed: options.orderSeed,
      seeds,
      conditions,
      scenarioCount: loaded.cases.length,
      trainCaseCount: loaded.trainCaseCount,
      heldoutCaseCount: loaded.heldoutCaseCount,
      trialCount: records.length,
      fpBudget: options.fpBudget,
      scorerVersion: SECURITY_SCORER_VERSION,
      fixtureDigest: loaded.fixtureDigest,
      provenance,
      withFoundry: options.withFoundry,
      foundryAvailable: foundry.available,
    },
    records,
    {
      manifestSchema: securityResultManifestSchema,
      recordSchema: securityTrialRecordSchema,
      summarize: (trialRecords) =>
        summarizeSecurity(trialRecords, options.fpBudget),
      renderMarkdown: securitySummaryMarkdown,
    },
  );

  const summary = summarizeSecurity(records, options.fpBudget);
  console.log(
    `Security instrumentation completed: ${summary.trialCount} trials.`,
  );
  console.log(
    `Semantic backend: ${semanticMetadata.backend} (${semanticMetadata.semaVersion}, ${semanticMetadata.canonicalizationVersion})`,
  );
  console.log(
    `Foundry: requested=${foundry.requested} available=${foundry.available} (${foundry.reason})`,
  );
  console.log(`Result bundle: ${bundle.directory}`);
  for (const condition of summary.conditions) {
    console.log(
      `${condition.condition.padEnd(22)} ` +
        `recall=${(condition.meanRecall * 100).toFixed(0)}% ` +
        `recall@budget=${(condition.recallAtFpBudget * 100).toFixed(0)}% ` +
        `TP=${condition.totalTruePositives} FP=${condition.totalFalsePositives}`,
    );
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
