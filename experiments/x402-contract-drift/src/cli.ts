import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MODEL_PROVIDER_NAMES,
  FixtureReferenceProvider,
  SemaPythonReferenceProvider,
  createModelProvider,
  isModelProvider,
  isSubscriptionHarnessProvider,
  modelProviderRequiresApiKey,
  type AnthropicThinkingMode,
  type CreatedModelProvider,
  type ModelAgentAdapter,
  type ModelCompletion,
  type ModelProvider,
  type ModelPromptInput,
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
import { createResultJournalWith } from "@sema-evals/reporters";

import { runX402SdkTransportConformance } from "./conformance.js";
import { buildConditions } from "./conditions.js";
import { runX402DriftTrial } from "./demo.js";
import { loadFixtureFile } from "./fixtures.js";
import {
  X402_PAPER_PAYER_SYSTEM_PROMPT,
  x402ModelReadinessGateSchema,
} from "./model-executor.js";
import { runModelX402DriftTrial } from "./model-demo.js";
import {
  SEMANTIC_EXTENSION_URI,
  X402_PROTOCOL_VERSION,
  x402DriftResultManifestSchema,
  x402DriftTrialRecordSchema,
  type X402DriftTrialRecord,
} from "./schemas.js";
import {
  X402_DRIFT_SCORER_VERSION,
  summarizeX402Drift,
  x402DriftSummaryMarkdown,
} from "./summary.js";

const EXPERIMENT_ID = "x402-contract-drift";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const READINESS_PATH = join(
  REPO_ROOT,
  "experiments/x402-contract-drift/model-readiness.json",
);
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL_PILOT_REPETITIONS = 5;
const DEFAULT_ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY";
const DEFAULT_OPENAI_KEY_ENV = "CHUTES_API_KEY";
const SUGGESTED_CHUTES_BASE_URL = "https://llm.chutes.ai/v1";
const DEFAULT_HARNESS_WORKSPACE = join(REPO_ROOT, "results/.harness-workspace");
const MAX_CONCURRENCY = 32;

type RunMode = "deterministic" | "model-pilot";

interface CliOptions {
  mode: RunMode;
  fixturePath: string;
  outputRoot: string;
  orderSeed: number;
  seedCount: number;
  seedCountExplicit: boolean;
  semanticBackend: "fixture" | "sema-python";
  semaPython: string;
  provider: ModelProvider;
  baseUrl: string;
  host: string;
  apiKeyEnv: string;
  model: string;
  harnessBin: string;
  harnessWorkingDirectory: string;
  thinking: AnthropicThinkingMode;
  maxTokens: number;
  concurrency: number;
}

export function runsModels(mode: RunMode): boolean {
  return mode === "model-pilot";
}

function usage(): string {
  return [
    "Usage: pnpm experiment:x402 -- [options]",
    "",
    "Options:",
    "  --mode <m>          deterministic or model-pilot (default: deterministic)",
    "  --fixtures <path>   YAML scenario fixture file",
    "  --output <path>     Result root directory",
    "  --order-seed <n>    Recorded randomization seed (default: 20260716)",
    "  --seeds <n>         Number of paired repetition seeds (default: 1)",
    "  --repetitions <n>   Alias for --seeds (model-pilot default: 5)",
    "  --semantic-backend  fixture or sema-python (default: fixture)",
    `  --provider <p>      ${MODEL_PROVIDER_NAMES} (default: anthropic)`,
    `  --base-url <url>    OpenAI-compatible endpoint (e.g. ${SUGGESTED_CHUTES_BASE_URL})`,
    "  --api-key-env <n>   API-key env var (default: ANTHROPIC_API_KEY or CHUTES_API_KEY)",
    "  --model <id>        Model id (required for openai-compatible and most harnesses)",
    "  --harness-bin <p>   Override subscription-harness CLI binary",
    "  --harness-cwd <p>   Working directory for subscription-harness calls",
    "  --thinking <m>      adaptive or none (anthropic only; default: adaptive)",
    "  --max-tokens <n>    Max output tokens (default: 4096)",
    `  --concurrency <n>   Model trials in flight (default: 1, max: ${MAX_CONCURRENCY})`,
    "",
    "model-pilot is exploratory and paper-only: the payer has no wallet, signing,",
    "network, facilitator, or production-write surface. It is fail-closed until",
    "the executable official-SDK transport conformance gate passes.",
  ].join("\n");
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} requires a positive integer.`);
  return parsed;
}
function nonnegativeInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${flag} requires a nonnegative integer.`);
  return parsed;
}
function boundedInteger(
  value: string | undefined,
  flag: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${flag} requires an integer between ${min} and ${max}.`);
  return parsed;
}
function resolveFromRepoRoot(value: string): string {
  return /[\\/]/.test(value) ? resolve(REPO_ROOT, value) : value;
}
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    throw new Error(
      `--base-url must be a valid URL (suggested: ${SUGGESTED_CHUTES_BASE_URL}).`,
    );
  }
}

export function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    mode: "deterministic",
    fixturePath: join(
      REPO_ROOT,
      "experiments/x402-contract-drift/fixtures/scenarios.yaml",
    ),
    outputRoot: join(REPO_ROOT, "results/x402-contract-drift"),
    orderSeed: 20_260_716,
    seedCount: 1,
    seedCountExplicit: false,
    semanticBackend: "fixture",
    semaPython: resolveFromRepoRoot(process.env.SEMA_PYTHON ?? "python3"),
    provider: "anthropic",
    baseUrl: "",
    host: "",
    apiKeyEnv: "",
    model: DEFAULT_MODEL,
    harnessBin: "",
    harnessWorkingDirectory: DEFAULT_HARNESS_WORKSPACE,
    thinking: "adaptive",
    maxTokens: DEFAULT_MAX_TOKENS,
    concurrency: 1,
  };
  let modelExplicit = false;
  let thinkingExplicit = false;
  let apiKeyEnvExplicit = false;
  let harnessBinExplicit = false;
  let harnessCwdExplicit = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--mode") {
      const mode = args[++index];
      if (mode !== "deterministic" && mode !== "model-pilot")
        throw new Error(`${argument} requires deterministic or model-pilot.`);
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
    if (argument === "--seeds" || argument === "--repetitions") {
      options.seedCount = positiveInteger(args[++index], argument);
      options.seedCountExplicit = true;
      continue;
    }
    if (argument === "--semantic-backend") {
      const backend = args[++index];
      if (backend !== "fixture" && backend !== "sema-python")
        throw new Error(`${argument} requires fixture or sema-python.`);
      options.semanticBackend = backend;
      continue;
    }
    if (argument === "--sema-python") {
      const command = args[++index];
      if (!command)
        throw new Error(`${argument} requires a Python executable.`);
      options.semaPython = resolveFromRepoRoot(command);
      continue;
    }
    if (argument === "--provider") {
      const provider = args[++index];
      if (!provider || !isModelProvider(provider))
        throw new Error(
          `${argument} requires one of: ${MODEL_PROVIDER_NAMES}.`,
        );
      options.provider = provider;
      continue;
    }
    if (argument === "--base-url") {
      const url = args[++index];
      if (!url) throw new Error(`${argument} requires a URL.`);
      options.baseUrl = url;
      continue;
    }
    if (argument === "--api-key-env") {
      const env = args[++index];
      if (!env) throw new Error(`${argument} requires an env var name.`);
      options.apiKeyEnv = env;
      apiKeyEnvExplicit = true;
      continue;
    }
    if (argument === "--model") {
      const model = args[++index];
      if (!model) throw new Error(`${argument} requires a model id.`);
      options.model = model;
      modelExplicit = true;
      continue;
    }
    if (argument === "--harness-bin") {
      const bin = args[++index];
      if (!bin) throw new Error(`${argument} requires a path or binary name.`);
      options.harnessBin = resolveFromRepoRoot(bin);
      harnessBinExplicit = true;
      continue;
    }
    if (argument === "--harness-cwd") {
      const cwd = args[++index];
      if (!cwd) throw new Error(`${argument} requires a directory.`);
      options.harnessWorkingDirectory = resolve(REPO_ROOT, cwd);
      harnessCwdExplicit = true;
      continue;
    }
    if (argument === "--thinking") {
      const thinking = args[++index];
      if (thinking !== "adaptive" && thinking !== "none")
        throw new Error(`${argument} requires adaptive or none.`);
      options.thinking = thinking;
      thinkingExplicit = true;
      continue;
    }
    if (argument === "--max-tokens") {
      options.maxTokens = positiveInteger(args[++index], argument);
      continue;
    }
    if (argument === "--concurrency") {
      options.concurrency = boundedInteger(
        args[++index],
        argument,
        1,
        MAX_CONCURRENCY,
      );
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }
  if (runsModels(options.mode) && !options.seedCountExplicit)
    options.seedCount = DEFAULT_MODEL_PILOT_REPETITIONS;
  if (options.provider === "openai-compatible") {
    if (thinkingExplicit)
      throw new Error("--thinking applies only to anthropic.");
    if (!options.baseUrl)
      throw new Error(
        `--base-url is required for provider openai-compatible (e.g. ${SUGGESTED_CHUTES_BASE_URL}).`,
      );
    if (!modelExplicit)
      throw new Error(
        "--model is required for provider openai-compatible; catalog slugs vary by endpoint.",
      );
    options.host = hostOf(options.baseUrl);
    options.apiKeyEnv = apiKeyEnvExplicit
      ? options.apiKeyEnv
      : DEFAULT_OPENAI_KEY_ENV;
    if (harnessBinExplicit || harnessCwdExplicit)
      throw new Error(
        "--harness-bin and --harness-cwd apply only to subscription CLI harness providers.",
      );
  } else if (options.provider === "anthropic") {
    if (harnessBinExplicit || harnessCwdExplicit)
      throw new Error(
        "--harness-bin and --harness-cwd apply only to subscription CLI harness providers.",
      );
    options.apiKeyEnv = apiKeyEnvExplicit
      ? options.apiKeyEnv
      : DEFAULT_ANTHROPIC_KEY_ENV;
  } else {
    if (thinkingExplicit)
      throw new Error(
        `--thinking applies only to anthropic; remove it for ${options.provider}.`,
      );
    if (options.baseUrl)
      throw new Error(
        `--base-url applies only to openai-compatible; remove it for ${options.provider}.`,
      );
    if (apiKeyEnvExplicit)
      throw new Error(
        `--api-key-env is unused for ${options.provider}; subscription authentication is ambient.`,
      );
    if (options.provider !== "claude-code" && !modelExplicit)
      throw new Error(
        `--model is required for provider ${options.provider}; harness model names vary.`,
      );
  }
  return options;
}

export function assertProviderApiKey(options: CliOptions): void {
  if (
    modelProviderRequiresApiKey(options.provider) &&
    !process.env[options.apiKeyEnv]
  )
    throw new Error(
      `model-pilot mode with provider ${options.provider} requires ${options.apiKeyEnv} to be set.`,
    );
}
function createExperimentModelProvider(
  options: CliOptions,
): CreatedModelProvider {
  return createModelProvider({
    provider: options.provider,
    systemPrompt: X402_PAPER_PAYER_SYSTEM_PROMPT,
    model: options.model,
    maxTokens: options.maxTokens,
    thinking: options.thinking,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
    ...(options.harnessBin ? { harnessBin: options.harnessBin } : {}),
    ...(isSubscriptionHarnessProvider(options.provider)
      ? { harnessWorkingDirectory: options.harnessWorkingDirectory }
      : {}),
  });
}
function createReferenceProvider(
  options: CliOptions,
): SemanticReferenceProvider {
  return options.semanticBackend === "sema-python"
    ? new SemaPythonReferenceProvider({ pythonCommand: options.semaPython })
    : new FixtureReferenceProvider();
}
async function loadReadiness(modelConfigured: boolean) {
  const declared = JSON.parse(await readFile(READINESS_PATH, "utf8"));
  const conformance = await runX402SdkTransportConformance();
  const gate = x402ModelReadinessGateSchema.parse({
    ...declared,
    modelConfigured,
    sdkConformanceReady: conformance.ready,
    ready: declared.paperReplayReady && modelConfigured && conformance.ready,
    blockReasons: [
      ...(declared.paperReplayReady ? [] : ["paper-replay-dataset-not-ready"]),
      ...(modelConfigured ? [] : ["model-provider-not-configured"]),
      ...(conformance.ready
        ? []
        : ["real-sdk-transport-conformance-not-complete"]),
    ],
  });
  return { gate, conformance };
}
function gitRevision(): string {
  if (process.env.IMPLEMENTATION_COMMIT)
    return process.env.IMPLEMENTATION_COMMIT;
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
  const isModelRun = runsModels(options.mode);
  if (isModelRun) assertProviderApiKey(options);
  const readinessCheck = isModelRun ? await loadReadiness(true) : undefined;
  const readiness = readinessCheck?.gate;
  if (isModelRun && !readiness?.ready)
    throw new Error(
      `x402 model-pilot is blocked: ${readiness?.blockReasons.join("; ")}. No model call was made.`,
    );
  const { fixtureDigest, fixtureSet, driftScenarioCount, cleanScenarioCount } =
    await loadFixtureFile(options.fixturePath);
  const conditions = buildConditions();
  let adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion> | undefined;
  let providerLabel = "";
  let harnessMetadata: Readonly<Record<string, string>> | null = null;
  if (isModelRun) {
    const created = createExperimentModelProvider(options);
    adapter = created.adapter;
    providerLabel = await created.providerLabel();
    harnessMetadata = created.harnessMetadata;
  }
  const referenceProvider = createReferenceProvider(options);
  const semanticMetadata = await referenceProvider.metadata();
  const vocabularyRoot = process.env.SEMA_VOCABULARY_ROOT ?? "";
  const seeds = Array.from({ length: options.seedCount }, (_, index) => index);
  const promptDigest = isModelRun
    ? sha256Text(X402_PAPER_PAYER_SYSTEM_PROMPT)
    : fingerprint({
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
    modelProvider: isModelRun
      ? providerLabel
      : (process.env.MODEL_PROVIDER ?? "deterministic"),
    modelName: isModelRun
      ? options.model
      : (process.env.MODEL_NAME ?? "x402-contract-drift-demo-v2"),
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
  const scorer = {
    version: X402_DRIFT_SCORER_VERSION,
    fingerprint: fingerprint({
      version: X402_DRIFT_SCORER_VERSION,
      primaryEndpoint: "silentPayment",
      cleanEndpoint: "falseHalt",
      modelFailurePolicy: "never-silent-payment",
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
  const createdAt = new Date();
  const runId = `${timestampId(createdAt)}-order-${options.orderSeed}`;
  const outputDirectory = join(options.outputRoot, runId);
  const manifest = x402DriftResultManifestSchema.parse({
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    x402ProtocolVersion: X402_PROTOCOL_VERSION,
    extensionUri: SEMANTIC_EXTENSION_URI,
    experimentId: EXPERIMENT_ID,
    runId,
    mode: isModelRun ? "model-pilot" : "deterministic-harness",
    evidenceClaim: isModelRun
      ? "Exploratory paper-only model pilot, not confirmatory evidence and not facilitator/on-chain conformance evidence. Only the payer decision is model-driven. Seller, registry drift, verification, enforcement, in-process transport, simulated payload, and settlement remain deterministic. No wallet, signing, network, facilitator, or production write is available."
      : "Validates the x402 V2-shaped payment-contract middleware and payer–seller demo. Scripted-agent outcomes are a construction, not evidence about language models or a real x402 SDK (ADR 0016).",
    createdAt: createdAt.toISOString(),
    orderSeed: options.orderSeed,
    seeds,
    conditions,
    scenarioCount: fixtureSet.scenarios.length,
    driftScenarioCount,
    cleanScenarioCount,
    trialCount: cells.length,
    fixtureDigest,
    scorer,
    protocolFingerprint,
    runConfiguration: {
      mode: options.mode,
      provider: provenance.modelProvider,
      model: provenance.modelName,
      endpointHost:
        isModelRun && options.provider === "openai-compatible"
          ? options.host
          : null,
      maxTokens: isModelRun ? options.maxTokens : null,
      thinking:
        isModelRun && options.provider === "anthropic"
          ? options.thinking
          : null,
      harness: isModelRun ? harnessMetadata : null,
      concurrency: options.concurrency,
      payerSystemPrompt: isModelRun ? X402_PAPER_PAYER_SYSTEM_PROMPT : null,
      paperOnly: true,
      productionWritesDisabled: true,
      sdkConformance: isModelRun ? readinessCheck?.conformance : null,
    },
    provenance,
  });
  const journal = await createResultJournalWith(outputDirectory, manifest, {
    manifestSchema: x402DriftResultManifestSchema,
    recordSchema: x402DriftTrialRecordSchema,
    summarize: summarizeX402Drift,
    renderMarkdown: (summary) =>
      x402DriftSummaryMarkdown(
        summary,
        isModelRun ? "model-pilot" : "deterministic-harness",
      ),
  });
  let records: X402DriftTrialRecord[];
  try {
    records = await executeMatrix(
      cells,
      (cell) =>
        isModelRun && adapter && readiness
          ? runModelX402DriftTrial(cell, {
              experimentId: EXPERIMENT_ID,
              referenceProvider,
              vocabularyRoot,
              provenance,
              adapter,
              readiness,
            })
          : runX402DriftTrial(cell, {
              experimentId: EXPERIMENT_ID,
              referenceProvider,
              vocabularyRoot,
              provenance,
            }),
      {
        concurrency: isModelRun ? options.concurrency : 1,
        onComplete: async (record) => journal.append(record),
      },
    );
  } catch (error) {
    await journal.fail(error);
    throw error;
  }
  const bundle = await journal.finalize(records);
  const summary = summarizeX402Drift(records);
  console.log(
    `${isModelRun ? "x402 model pilot" : "x402 contract-drift demo"} completed: ${summary.trialCount} trials.`,
  );
  console.log(`Result bundle: ${bundle.directory}`);
  for (const condition of summary.conditions)
    console.log(
      `${condition.condition.padEnd(21)} silent=${(condition.silentPaymentRate * 100).toFixed(0)}% detected=${(condition.detectionRate * 100).toFixed(0)}% correctRefusals=${condition.correctHalts} falseRefusals=${condition.falseHalts}`,
    );
}
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}
if (isEntryPoint())
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
