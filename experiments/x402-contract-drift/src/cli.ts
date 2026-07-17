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
import { runX402DriftTrial } from "./demo.js";
import { loadFixtureFile } from "./fixtures.js";
import {
  SEMANTIC_EXTENSION_URI,
  X402_PROTOCOL_VERSION,
  x402DriftResultManifestSchema,
  x402DriftTrialRecordSchema,
} from "./schemas.js";
import {
  X402_DRIFT_SCORER_VERSION,
  summarizeX402Drift,
  x402DriftSummaryMarkdown,
} from "./summary.js";

const EXPERIMENT_ID = "x402-contract-drift";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
    "Usage: pnpm experiment:x402 -- [options]",
    "",
    "Options:",
    "  --fixtures <path>   YAML scenario fixture file",
    "  --output <path>     Result root directory",
    "  --order-seed <n>    Recorded randomization seed (default: 20260716)",
    "  --seeds <n>         Number of paired repetition seeds (default: 1)",
    "  --semantic-backend  fixture or sema-python (default: fixture)",
    "  --sema-python <cmd> Python executable with semahash installed",
    "  --help              Show this help",
    "",
    "Deterministic harness only. Model-pilot mode is future work (ADR 0016).",
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
    fixturePath: join(
      REPO_ROOT,
      "experiments/x402-contract-drift/fixtures/scenarios.yaml",
    ),
    outputRoot: join(REPO_ROOT, "results/x402-contract-drift"),
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

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
    policy: "deterministic-x402-contract-drift-demo-v2",
    extensionUri: SEMANTIC_EXTENSION_URI,
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
    modelName: process.env.MODEL_NAME ?? "x402-contract-drift-demo-v2",
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
    runX402DriftTrial(cell, {
      experimentId: EXPERIMENT_ID,
      referenceProvider,
      vocabularyRoot,
      provenance,
    }),
  );

  const createdAt = new Date();
  const runId = `${timestampId(createdAt)}-order-${options.orderSeed}`;
  const outputDirectory = join(options.outputRoot, runId);
  const scorer = {
    version: X402_DRIFT_SCORER_VERSION,
    fingerprint: fingerprint({
      version: X402_DRIFT_SCORER_VERSION,
      primaryEndpoint: "silentPayment",
      cleanEndpoint: "falseHalt",
    }),
  };
  const protocolFingerprint = fingerprint({
    experimentId: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    x402ProtocolVersion: X402_PROTOCOL_VERSION,
    extensionUri: SEMANTIC_EXTENSION_URI,
    conditions,
    fixtureDigest,
    scorer,
  });
  const bundle = await writeResultBundleWith(
    outputDirectory,
    {
      artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      x402ProtocolVersion: X402_PROTOCOL_VERSION,
      extensionUri: SEMANTIC_EXTENSION_URI,
      experimentId: EXPERIMENT_ID,
      runId,
      mode: "deterministic-harness" as const,
      evidenceClaim:
        "Validates the x402 V2-shaped payment-contract middleware and payer–seller demo: top-level PaymentRequired semantic extension, CAIP-2 network identifiers, PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers, controlled cross-party registry drift, silent payment under baseline, voluntary detection, enforced refusal, the no-drift false-refusal guard, condition pairing, and bundle/summary reproduction. Scripted-agent outcomes are a construction, not evidence about language models, and not conformance evidence against a real x402 SDK (ADR 0016).",
      createdAt: createdAt.toISOString(),
      orderSeed: options.orderSeed,
      seeds,
      conditions,
      scenarioCount: fixtureSet.scenarios.length,
      driftScenarioCount,
      cleanScenarioCount,
      trialCount: records.length,
      fixtureDigest,
      scorer,
      protocolFingerprint,
      runConfiguration: {
        mode: "deterministic-harness",
        orderSeed: options.orderSeed,
        repetitionCount: options.seedCount,
        semanticBackend: semanticMetadata.backend,
        semaVersion: semanticMetadata.semaVersion,
        canonicalizationVersion: semanticMetadata.canonicalizationVersion,
        vocabularyRoot,
        x402ProtocolVersion: X402_PROTOCOL_VERSION,
        wireHeaders: [
          "PAYMENT-REQUIRED",
          "PAYMENT-SIGNATURE",
          "PAYMENT-RESPONSE",
        ],
      },
      provenance,
    },
    records,
    {
      manifestSchema: x402DriftResultManifestSchema,
      recordSchema: x402DriftTrialRecordSchema,
      summarize: summarizeX402Drift,
      renderMarkdown: x402DriftSummaryMarkdown,
    },
  );

  const summary = summarizeX402Drift(records);
  console.log(
    `x402 contract-drift demo completed: ${summary.trialCount} trials.`,
  );
  console.log(
    `Semantic backend: ${semanticMetadata.backend} (${semanticMetadata.semaVersion}, ${semanticMetadata.canonicalizationVersion})`,
  );
  console.log(`Extension: ${SEMANTIC_EXTENSION_URI}`);
  console.log(`Result bundle: ${bundle.directory}`);
  for (const condition of summary.conditions) {
    console.log(
      `${condition.condition.padEnd(21)} ` +
        `silent=${(condition.silentPaymentRate * 100).toFixed(0)}% ` +
        `detected=${(condition.detectionRate * 100).toFixed(0)}% ` +
        `correctRefusals=${condition.correctHalts} falseRefusals=${condition.falseHalts}`,
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
