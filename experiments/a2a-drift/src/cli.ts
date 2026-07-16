import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AnthropicModelAdapter,
  FixtureReferenceProvider,
  OpenAiCompatibleModelAdapter,
  SemaPythonReferenceProvider,
  type AnthropicThinkingMode,
  type ModelAgentAdapter,
  type ModelCompletion,
  type ModelPromptInput,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  executeMatrix,
  fingerprint,
  loadPromptSnapshot,
  planPairedMatrix,
  sha256Text,
  type PromptSnapshot,
  type TrialProvenance,
} from "@sema-evals/core";
import { writeResultBundleWith } from "@sema-evals/reporters";

import { buildConditions } from "./conditions.js";
import { A2A_DECISION_PARSER_VERSION } from "./decision.js";
import { runA2aDriftTrial } from "./demo.js";
import { loadFixtureFile } from "./fixtures.js";
import { runModelA2aDriftTrial } from "./model-demo.js";
import {
  A2A_PROTOCOL_VERSION,
  SEMANTIC_EXTENSION_URI,
  a2aDriftResultManifestSchema,
  a2aDriftTrialRecordSchema,
  type A2aDriftTrialRecord,
} from "./schemas.js";
import { a2aDriftSummaryMarkdown, summarizeA2aDrift } from "./summary.js";

const EXPERIMENT_ID = "a2a-drift";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROMPTS_DIR = join(REPO_ROOT, "experiments/a2a-drift/prompts");
const WORKER_PROMPT_KEY = "worker";

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL_PILOT_REPETITIONS = 5;
const DEFAULT_ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY";
const DEFAULT_OPENAI_KEY_ENV = "CHUTES_API_KEY";
const SUGGESTED_CHUTES_BASE_URL = "https://llm.chutes.ai/v1";
const MAX_CONCURRENCY = 32;

type RunMode = "deterministic" | "model-pilot";
type ModelProvider = "anthropic" | "openai-compatible";

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
  /** Host derived from `baseUrl`, e.g. `llm.chutes.ai`. Empty for anthropic. */
  host: string;
  /** Env var name checked for presence and read by the adapter (never here). */
  apiKeyEnv: string;
  model: string;
  thinking: AnthropicThinkingMode;
  maxTokens: number;
  /** Trials in flight at once. Only meaningful in model-pilot mode; a value
   * above 1 is ignored (with a note) in deterministic mode. */
  concurrency: number;
}

/** Modes that invoke a model provider. */
export function runsModels(mode: RunMode): boolean {
  return mode === "model-pilot";
}

/** Fail fast when a model cannot serve the requested thinking mode. */
export function validateThinkingForModel(
  model: string,
  thinking: AnthropicThinkingMode,
): void {
  if (model === "claude-haiku-4-5" && thinking === "adaptive") {
    throw new Error(
      "claude-haiku-4-5 does not support adaptive thinking. Pass --thinking none.",
    );
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    throw new Error(
      `--base-url must be a valid URL (received "${baseUrl}"). Suggested: ${SUGGESTED_CHUTES_BASE_URL}`,
    );
  }
}

/**
 * Fails fast before any work when the selected provider's API key env var is
 * unset. Presence-only: the value is never read beyond truthiness.
 */
export function assertProviderApiKey(options: CliOptions): void {
  if (!process.env[options.apiKeyEnv]) {
    throw new Error(
      `model-pilot mode with provider ${options.provider} requires ${options.apiKeyEnv} to be set. Export it before running.`,
    );
  }
}

function usage(): string {
  return [
    "Usage: pnpm experiment:a2a -- [options]",
    "",
    "Options:",
    "  --mode <m>          deterministic or model-pilot (default: deterministic)",
    "  --fixtures <path>   YAML scenario fixture file",
    "  --output <path>     Result root directory",
    "  --order-seed <n>    Recorded randomization seed (default: 20260714)",
    "  --seeds <n>         Number of paired repetition seeds (default: 1)",
    "  --repetitions <n>   Alias for --seeds (model-pilot default: 5)",
    "  --semantic-backend  fixture or sema-python (default: fixture)",
    "  --sema-python <cmd> Python executable with semahash installed",
    "  --provider <p>      anthropic or openai-compatible (default: anthropic)",
    "  --base-url <url>    OpenAI-compatible endpoint base URL (required for",
    `                      openai-compatible; e.g. ${SUGGESTED_CHUTES_BASE_URL})`,
    "  --api-key-env <n>   Env var holding the API key (default:",
    "                      ANTHROPIC_API_KEY for anthropic, CHUTES_API_KEY for",
    "                      openai-compatible)",
    "  --model <id>        Model id (anthropic default: claude-sonnet-5;",
    "                      required for openai-compatible)",
    "  --thinking <m>      adaptive or none (default: adaptive; anthropic only)",
    "  --max-tokens <n>    Max output tokens (default: 4096)",
    `  --concurrency <n>   Trials in flight at once (default: 1, max: ${MAX_CONCURRENCY};`,
    "                      model-pilot only; ignored in deterministic mode)",
    "  --help              Show this help",
    "",
    "model-pilot mode drives only the worker through a real model adapter;",
    "requester, transport, registries, drift injection, and middleware stay",
    "deterministic. Requires the selected provider's API key env var.",
    `Decision parser: ${A2A_DECISION_PARSER_VERSION}.`,
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

function boundedInteger(
  value: string | undefined,
  flag: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} requires an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function resolveFromRepoRoot(value: string): string {
  return /[\\/]/.test(value) ? resolve(REPO_ROOT, value) : value;
}

export function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    mode: "deterministic",
    fixturePath: join(
      REPO_ROOT,
      "experiments/a2a-drift/fixtures/scenarios.yaml",
    ),
    outputRoot: join(REPO_ROOT, "results/a2a-drift"),
    orderSeed: 20_260_714,
    seedCount: 1,
    seedCountExplicit: false,
    semanticBackend: "fixture",
    semaPython: resolveFromRepoRoot(process.env.SEMA_PYTHON ?? "python3"),
    provider: "anthropic",
    baseUrl: "",
    host: "",
    apiKeyEnv: "",
    model: DEFAULT_MODEL,
    thinking: "adaptive",
    maxTokens: DEFAULT_MAX_TOKENS,
    concurrency: 1,
  };
  let modelExplicit = false;
  let thinkingExplicit = false;
  let apiKeyEnvExplicit = false;

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
      if (mode !== "deterministic" && mode !== "model-pilot") {
        throw new Error(`${argument} requires deterministic or model-pilot.`);
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
    if (argument === "--seeds" || argument === "--repetitions") {
      options.seedCount = positiveInteger(args[++index], argument);
      options.seedCountExplicit = true;
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
    if (argument === "--provider") {
      const provider = args[++index];
      if (provider !== "anthropic" && provider !== "openai-compatible") {
        throw new Error(`${argument} requires anthropic or openai-compatible.`);
      }
      options.provider = provider;
      continue;
    }
    if (argument === "--base-url") {
      const baseUrl = args[++index];
      if (!baseUrl) {
        throw new Error(`${argument} requires a URL.`);
      }
      options.baseUrl = baseUrl;
      continue;
    }
    if (argument === "--api-key-env") {
      const apiKeyEnv = args[++index];
      if (!apiKeyEnv) {
        throw new Error(`${argument} requires an env var name.`);
      }
      options.apiKeyEnv = apiKeyEnv;
      apiKeyEnvExplicit = true;
      continue;
    }
    if (argument === "--model") {
      const model = args[++index];
      if (!model) {
        throw new Error(`${argument} requires a model id.`);
      }
      options.model = model;
      modelExplicit = true;
      continue;
    }
    if (argument === "--thinking") {
      const thinking = args[++index];
      if (thinking !== "adaptive" && thinking !== "none") {
        throw new Error(`${argument} requires adaptive or none.`);
      }
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

  if (runsModels(options.mode) && !options.seedCountExplicit) {
    options.seedCount = DEFAULT_MODEL_PILOT_REPETITIONS;
  }

  if (options.provider === "openai-compatible") {
    if (thinkingExplicit) {
      throw new Error(
        "--thinking applies only to the anthropic provider. Remove it for openai-compatible.",
      );
    }
    if (!options.baseUrl) {
      throw new Error(
        `--base-url is required for provider openai-compatible (e.g. ${SUGGESTED_CHUTES_BASE_URL}).`,
      );
    }
    if (!modelExplicit) {
      throw new Error(
        "--model is required for provider openai-compatible; catalog slugs vary by endpoint.",
      );
    }
    options.host = hostOf(options.baseUrl);
    options.apiKeyEnv = apiKeyEnvExplicit
      ? options.apiKeyEnv
      : DEFAULT_OPENAI_KEY_ENV;
  } else {
    validateThinkingForModel(options.model, options.thinking);
    options.apiKeyEnv = apiKeyEnvExplicit
      ? options.apiKeyEnv
      : DEFAULT_ANTHROPIC_KEY_ENV;
  }

  return options;
}

function requireWorkerPrompt(snapshot: PromptSnapshot): string {
  const prompt = snapshot.prompts[WORKER_PROMPT_KEY];
  if (!prompt) {
    throw new Error(
      `Prompt snapshot is missing the ${WORKER_PROMPT_KEY} prompt.`,
    );
  }
  return prompt.content;
}

function createModelAdapter(
  snapshot: PromptSnapshot,
  options: CliOptions,
): ModelAgentAdapter<ModelPromptInput, ModelCompletion> {
  const systemPrompt = requireWorkerPrompt(snapshot);
  if (options.provider === "openai-compatible") {
    return new OpenAiCompatibleModelAdapter({
      systemPrompt,
      baseUrl: options.baseUrl,
      apiKeyEnvVar: options.apiKeyEnv,
      model: options.model,
      maxTokens: options.maxTokens,
    });
  }
  return new AnthropicModelAdapter({
    systemPrompt,
    model: options.model,
    maxTokens: options.maxTokens,
    thinkingMode: options.thinking,
  });
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

/**
 * One human-readable progress line per completed trial, written to stderr so
 * stdout stays reserved for the machine-parseable summary.
 */
function trialProgressLine(
  record: A2aDriftTrialRecord,
  done: number,
  total: number,
): string {
  const elapsed = (record.metrics.elapsedMs / 1000).toFixed(1);
  const calls = record.usage?.attempts ?? 0;
  const decision = record.modelDecision ?? "n/a";
  const outcome = record.metrics.taskSuccess ? "taskSuccess" : "fail";
  return (
    `trial ${done}/${total} ${record.scenarioId} ${record.condition} ` +
    `seed=${record.seed} -> ${decision} [${outcome}] ` +
    `(${elapsed}s, ${calls} calls)`
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const isModelRun = runsModels(options.mode);

  if (isModelRun) {
    assertProviderApiKey(options);
  }

  let concurrency = options.concurrency;
  if (!isModelRun && concurrency > 1) {
    console.error(
      `Note: --concurrency ${concurrency} is ignored in deterministic mode; running sequentially.`,
    );
    concurrency = 1;
  }

  const { fixtureDigest, fixtureSet, driftScenarioCount, cleanScenarioCount } =
    await loadFixtureFile(options.fixturePath);
  const conditions = buildConditions();

  let promptSnapshot: PromptSnapshot | undefined;
  let adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion> | undefined;
  if (isModelRun) {
    promptSnapshot = await loadPromptSnapshot(PROMPTS_DIR);
    adapter = createModelAdapter(promptSnapshot, options);

    const scenarioCount = fixtureSet.scenarios.length;
    const conditionCount = conditions.length;
    const trialCount = scenarioCount * conditionCount * options.seedCount;
    console.log("A2A drift model pilot (exploratory, not confirmatory).");
    console.log(
      options.provider === "openai-compatible"
        ? `Provider: openai-compatible (${options.baseUrl}, host=${options.host})`
        : "Provider: anthropic",
    );
    const modelSuffix =
      options.provider === "openai-compatible"
        ? `max-tokens=${options.maxTokens}`
        : `thinking=${options.thinking}, max-tokens=${options.maxTokens}`;
    console.log(`Model: ${options.model} (${modelSuffix})`);
    console.log(
      `Planned: ${scenarioCount} scenarios x ${conditionCount} conditions x ` +
        `${options.seedCount} repetitions = ${trialCount} trials ` +
        `(1 model call each; worker only).`,
    );
    console.log(
      concurrency > 1
        ? `Concurrency: up to ${concurrency} trials in flight (started in planned order).`
        : "Concurrency: 1 (sequential).",
    );
  }

  const referenceProvider = createReferenceProvider(options);
  const semanticMetadata = await referenceProvider.metadata();
  const vocabularyRoot = process.env.SEMA_VOCABULARY_ROOT ?? "";
  const seeds = Array.from({ length: options.seedCount }, (_, index) => index);

  const promptDigest =
    isModelRun && promptSnapshot
      ? promptSnapshot.promptDigest
      : fingerprint({
          experiment: EXPERIMENT_ID,
          protocolVersion: PROTOCOL_VERSION,
          policy: "deterministic-a2a-drift-demo-v1",
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
      ? options.provider === "openai-compatible"
        ? options.host
        : "anthropic"
      : (process.env.MODEL_PROVIDER ?? "deterministic"),
    modelName: isModelRun
      ? options.model
      : (process.env.MODEL_NAME ?? "a2a-drift-demo-v1"),
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

  const total = cells.length;
  let completed = 0;
  if (isModelRun) {
    console.error(`Running ${total} trials, concurrency ${concurrency}...`);
  }

  const records = await executeMatrix(
    cells,
    (cell) => {
      if (isModelRun && adapter) {
        return runModelA2aDriftTrial(cell, {
          experimentId: EXPERIMENT_ID,
          referenceProvider,
          vocabularyRoot,
          provenance,
          adapter,
        });
      }
      return runA2aDriftTrial(cell, {
        experimentId: EXPERIMENT_ID,
        referenceProvider,
        vocabularyRoot,
        provenance,
      });
    },
    {
      concurrency,
      ...(isModelRun
        ? {
            onComplete: (record: A2aDriftTrialRecord): void => {
              completed += 1;
              console.error(trialProgressLine(record, completed, total));
            },
          }
        : {}),
    },
  );

  const createdAt = new Date();
  const runId = `${timestampId(createdAt)}-order-${options.orderSeed}`;
  const outputDirectory = join(options.outputRoot, runId);
  const bundle = await writeResultBundleWith(
    outputDirectory,
    {
      artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      a2aProtocolVersion: A2A_PROTOCOL_VERSION,
      extensionUri: SEMANTIC_EXTENSION_URI,
      experimentId: EXPERIMENT_ID,
      runId,
      mode: isModelRun
        ? ("model-pilot" as const)
        : ("deterministic-harness" as const),
      evidenceClaim: isModelRun
        ? "Exploratory model pilot. Not preregistered, not confirmatory evidence. Worker is model-driven; requester, transport, registries, drift injection, and middleware remain deterministic. Ground-truth driftDetected is middleware-only (ADR 0015)."
        : "Validates the A2A semantic-extension middleware and two-agent demo: Agent Card extension advertisement, acceptance-contract message parts, controlled cross-agent registry drift, silent execution under baseline, voluntary detection, enforced halt, the no-drift false-halt guard, condition pairing, and bundle/summary reproduction. Scripted-agent outcomes are a construction, not evidence about language models, and not conformance evidence against a real A2A SDK (ADR 0012).",
      createdAt: createdAt.toISOString(),
      orderSeed: options.orderSeed,
      seeds,
      conditions,
      scenarioCount: fixtureSet.scenarios.length,
      driftScenarioCount,
      cleanScenarioCount,
      trialCount: records.length,
      fixtureDigest,
      provenance,
    },
    records,
    {
      manifestSchema: a2aDriftResultManifestSchema,
      recordSchema: a2aDriftTrialRecordSchema,
      summarize: summarizeA2aDrift,
      renderMarkdown: a2aDriftSummaryMarkdown,
    },
  );

  const summary = summarizeA2aDrift(records);
  console.log(
    isModelRun
      ? `A2A drift model pilot completed: ${summary.trialCount} trials.`
      : `A2A drift demo completed: ${summary.trialCount} trials.`,
  );
  console.log(
    `Semantic backend: ${semanticMetadata.backend} (${semanticMetadata.semaVersion}, ${semanticMetadata.canonicalizationVersion})`,
  );
  console.log(`Extension: ${SEMANTIC_EXTENSION_URI}`);
  console.log(`Result bundle: ${bundle.directory}`);
  for (const condition of summary.conditions) {
    console.log(
      `${condition.condition.padEnd(21)} ` +
        `silent=${(condition.silentExecutionRate * 100).toFixed(0)}% ` +
        `detected=${(condition.detectionRate * 100).toFixed(0)}% ` +
        `correctHalts=${condition.correctHalts} falseHalts=${condition.falseHalts}`,
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
