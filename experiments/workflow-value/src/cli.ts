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
  loadPromptSnapshot,
  planPairedMatrix,
  sha256Text,
  type TrialProvenance,
} from "@sema-evals/core";
import { createResultJournalWith } from "@sema-evals/reporters";

import { buildConditions } from "./conditions.js";
import { evaluateDatasetAcquisitionGate, loadFixtureFile } from "./fixtures.js";
import {
  WORKFLOW_VALUE_SCORER_FINGERPRINT,
  WORKFLOW_VALUE_SCORER_VERSION,
} from "./scorer.js";
import {
  WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE,
  WORKFLOW_TOTAL_TOKEN_BUDGET,
  WORKFLOW_VALUE_PROTOCOL_VERSION,
  workflowValueResultManifestSchema,
  workflowValueTrialRecordSchema,
  type WorkflowValueTrialRecord,
} from "./schemas.js";
import {
  summarizeWorkflowValue,
  workflowValueSummaryMarkdown,
} from "./summary.js";
import { runDeterministicWorkflowTrial } from "./trial.js";

const EXPERIMENT_ID = "workflow-value";
const WORKFLOW_POLICY = "deterministic-workflow-value-scaffold-v1";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROMPTS_DIR = join(REPO_ROOT, "experiments/workflow-value/prompts");

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
    "Usage: pnpm experiment:workflow-value -- [options]",
    "",
    "Options:",
    "  --mode <m>          deterministic-harness (only supported mode)",
    "  --fixtures <path>   Seed workflow fixture file",
    "  --output <path>     Result root directory",
    "  --order-seed <n>    Paired randomization seed (default: 20260716)",
    "  --seeds <n>         Number of paired repetition seeds (default: 1)",
    "  --semantic-backend  fixture or sema-python (default: fixture)",
    "  --sema-python <cmd> Python executable with semahash installed",
    "  --help              Show this help",
    "",
    `Fixed total-token budget: ${WORKFLOW_TOTAL_TOKEN_BUDGET} input+output tokens.`,
    "Model-pilot mode is blocked until the dataset-acquisition gate passes.",
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
      "experiments/workflow-value/fixtures/seed-tasks.yaml",
    ),
    outputRoot: join(REPO_ROOT, "results/workflow-value"),
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
          `${argument} requires deterministic-harness; model-pilot is gated and not runnable.`,
        );
      }
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
  return options.semanticBackend === "sema-python"
    ? new SemaPythonReferenceProvider({ pythonCommand: options.semaPython })
    : new FixtureReferenceProvider();
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

export async function runWorkflowValueCli(
  args: readonly string[],
): Promise<string> {
  const options = parseArgs(args);
  const { fixtureDigest, fixtureSet, devTaskCount, evalTaskCount } =
    await loadFixtureFile(options.fixturePath);
  const datasetGate = evaluateDatasetAcquisitionGate(fixtureSet);
  const promptSnapshot = await loadPromptSnapshot(PROMPTS_DIR);
  const referenceProvider = createReferenceProvider(options);
  const semanticMetadata = await referenceProvider.metadata();
  const conditions = buildConditions();
  const seeds = Array.from({ length: options.seedCount }, (_, index) => index);
  const provenance: TrialProvenance = {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    protocolVersion: WORKFLOW_VALUE_PROTOCOL_VERSION,
    fixtureDigest,
    implementationCommit: gitRevision(),
    dependencyLockDigest: await fileDigest(join(REPO_ROOT, "pnpm-lock.yaml")),
    promptDigest: promptSnapshot.promptDigest,
    semaVersion: semanticMetadata.semaVersion,
    canonicalizationVersion: semanticMetadata.canonicalizationVersion,
    vocabularyRoot: process.env.SEMA_VOCABULARY_ROOT ?? "",
    semanticBackend: semanticMetadata.backend,
    modelProvider: "deterministic",
    modelName: "workflow-value-scripted-executor-v1",
  };
  const cells = planPairedMatrix({
    experimentId: EXPERIMENT_ID,
    protocolVersion: WORKFLOW_VALUE_PROTOCOL_VERSION,
    scenarios: fixtureSet.tasks,
    scenarioId: (task) => task.id,
    conditions,
    seeds,
    orderSeed: options.orderSeed,
  });
  const protocolFingerprint = fingerprint({
    experimentId: EXPERIMENT_ID,
    protocolVersion: WORKFLOW_VALUE_PROTOCOL_VERSION,
    policy: WORKFLOW_POLICY,
    conditions,
    tokenBudget: WORKFLOW_TOTAL_TOKEN_BUDGET,
    invocationTokenReserve: WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE,
    scorer: WORKFLOW_VALUE_SCORER_FINGERPRINT,
    fixtureDigest,
    promptDigest: promptSnapshot.promptDigest,
  });
  const createdAt = new Date();
  const runId = `${timestampId(createdAt)}-order-${options.orderSeed}`;
  const outputDirectory = join(options.outputRoot, runId);
  const manifest = workflowValueResultManifestSchema.parse({
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    protocolVersion: WORKFLOW_VALUE_PROTOCOL_VERSION,
    experimentId: EXPERIMENT_ID,
    runId,
    mode: "deterministic-harness",
    evidenceClaim:
      "Validates the workflow-value scaffold mechanics only: clearly labelled synthetic seed tasks, hidden executable validators, dev/eval separation, paired randomized conditions, fixed token-budget accounting, semantic delivery channels, repair notice handling, and durable result preservation. Scripted outcomes are not evidence about model performance (ADR 0021).",
    createdAt: createdAt.toISOString(),
    orderSeed: options.orderSeed,
    seeds,
    conditions,
    devTaskCount,
    evalTaskCount,
    trialCount: cells.length,
    tokenBudget: WORKFLOW_TOTAL_TOKEN_BUDGET,
    invocationTokenReserve: WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE,
    fixtureDigest,
    datasetGate,
    scorer: {
      version: WORKFLOW_VALUE_SCORER_VERSION,
      fingerprint: WORKFLOW_VALUE_SCORER_FINGERPRINT,
    },
    protocolFingerprint,
    runConfiguration: {
      mode: "deterministic-harness",
      seeds,
      orderSeed: options.orderSeed,
      tokenBudget: WORKFLOW_TOTAL_TOKEN_BUDGET,
      invocationTokenReserve: WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE,
      semanticBackend: semanticMetadata.backend,
      policy: WORKFLOW_POLICY,
    },
    provenance,
  });
  const journal = await createResultJournalWith(outputDirectory, manifest, {
    manifestSchema: workflowValueResultManifestSchema,
    recordSchema: workflowValueTrialRecordSchema,
    summarize: summarizeWorkflowValue,
    renderMarkdown: workflowValueSummaryMarkdown,
  });

  let records: WorkflowValueTrialRecord[];
  try {
    records = await executeMatrix(
      cells,
      (cell) =>
        runDeterministicWorkflowTrial(cell, {
          experimentId: EXPERIMENT_ID,
          datasetLabel: fixtureSet.dataset.label,
          referenceProvider,
          provenance,
        }),
      {
        onComplete: (record) => journal.append(record),
      },
    );
  } catch (error) {
    await journal.fail(error);
    throw error;
  }
  const bundle = await journal.finalize(records);
  const summary = summarizeWorkflowValue(records);

  console.log(
    `Workflow value scaffold completed: ${summary.trialCount} trials.`,
  );
  console.log(
    datasetGate.readyForModelPilot
      ? `Dataset gate: READY (${datasetGate.status}).`
      : `Dataset gate: BLOCKED (${datasetGate.status}); seed fixtures are not an evaluation dataset.`,
  );
  console.log(
    `Semantic backend: ${semanticMetadata.backend} (${semanticMetadata.semaVersion}, ${semanticMetadata.canonicalizationVersion})`,
  );
  console.log(`Result bundle: ${bundle.directory}`);
  return bundle.directory;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  runWorkflowValueCli(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
