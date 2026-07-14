import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  EXPERIMENT_CONDITIONS,
  PROTOCOL_VERSION,
  executeMatrix,
  fingerprint,
  planPairedMatrix,
  sha256Text,
  type TrialProvenance,
} from "@sema-evals/core";
import { summarizeTrials, writeResultBundle } from "@sema-evals/reporters";

import { loadScenarioFile } from "./fixtures.js";
import { runRelayTrial } from "./relay.js";

const EXPERIMENT_ID = "babel-relay";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface CliOptions {
  fixturePath: string;
  outputRoot: string;
  orderSeed: number;
  seedCount: number;
}

function usage(): string {
  return [
    "Usage: pnpm experiment:babel -- [options]",
    "",
    "Options:",
    "  --fixtures <path>   YAML scenario file",
    "  --output <path>     Result root directory",
    "  --order-seed <n>    Recorded randomization seed (default: 20260714)",
    "  --seeds <n>         Number of paired repetition seeds (default: 1)",
    "  --help              Show this help",
  ].join("\n");
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

function nonnegativeInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a nonnegative integer.`);
  }
  return parsed;
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    fixturePath: join(
      REPO_ROOT,
      "experiments/babel-relay/fixtures/scenarios.yaml",
    ),
    outputRoot: join(REPO_ROOT, "results/babel-relay"),
    orderSeed: 20_260_714,
    seedCount: 1,
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
      options.fixturePath = resolve(args[++index] ?? "");
      continue;
    }
    if (argument === "--output") {
      options.outputRoot = resolve(args[++index] ?? "");
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
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }

  return options;
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
  const { fixtureDigest, scenarioSet } = await loadScenarioFile(
    options.fixturePath,
  );
  const referenceProvider = new FixtureReferenceProvider();
  const seeds = Array.from({ length: options.seedCount }, (_, index) => index);
  const promptDigest = fingerprint({
    experiment: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    policy: "deterministic-relay-v1",
  });
  const provenance: TrialProvenance = {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    fixtureDigest,
    implementationCommit: gitRevision(),
    dependencyLockDigest: await fileDigest(join(REPO_ROOT, "pnpm-lock.yaml")),
    promptDigest,
    semaVersion: process.env.SEMA_VERSION ?? "not-connected",
    canonicalizationVersion: "fixture-stable-json-v1",
    vocabularyRoot: process.env.SEMA_VOCABULARY_ROOT ?? "",
    semanticBackend: referenceProvider.backend,
    modelProvider: process.env.MODEL_PROVIDER ?? "deterministic",
    modelName: process.env.MODEL_NAME ?? "deterministic-relay-v1",
  };

  const cells = planPairedMatrix({
    experimentId: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    scenarios: scenarioSet.scenarios,
    scenarioId: (scenario) => scenario.id,
    conditions: EXPERIMENT_CONDITIONS,
    seeds,
    orderSeed: options.orderSeed,
  });

  const records = await executeMatrix(cells, (cell) =>
    runRelayTrial(cell, {
      experimentId: EXPERIMENT_ID,
      referenceProvider,
      provenance,
    }),
  );
  const createdAt = new Date();
  const runId = `${timestampId(createdAt)}-order-${options.orderSeed}`;
  const outputDirectory = join(options.outputRoot, runId);
  const bundle = await writeResultBundle(
    outputDirectory,
    {
      artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      experimentId: EXPERIMENT_ID,
      runId,
      mode: "deterministic-harness",
      evidenceClaim:
        "Validates condition mechanics, drift scoring, randomization, and artifact reporting only.",
      createdAt: createdAt.toISOString(),
      orderSeed: options.orderSeed,
      seeds,
      conditions: [...EXPERIMENT_CONDITIONS],
      scenarioCount: scenarioSet.scenarios.length,
      trialCount: records.length,
      fixtureDigest,
      provenance,
    },
    records,
  );

  const summary = summarizeTrials(records);
  console.log(`Babel Relay completed: ${summary.trialCount} trials.`);
  console.log(`Result bundle: ${bundle.directory}`);
  for (const condition of summary.conditions) {
    console.log(
      `${condition.condition.padEnd(20)} success=${(condition.taskSuccessRate * 100).toFixed(1)}% ` +
        `silent-drift=${(condition.silentDivergenceRate * 100).toFixed(1)}%`,
    );
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
