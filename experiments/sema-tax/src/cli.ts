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

import { SEMA_TAX_PATTERN_COUNTS, buildConditions } from "./conditions.js";
import { loadFixtureFile } from "./fixtures.js";
import { runModelTaxTrial } from "./model-tax.js";
import {
  semaTaxResultManifestSchema,
  semaTaxTrialRecordSchema,
  type SemaTaxTrialRecord,
} from "./schemas.js";
import {
  buildSizeReuseConditions,
  parseSizeReuseCondition,
} from "./size-reuse/conditions.js";
import {
  runModelSizeReuseTrial,
  runSimulatedSizeReuseTrial,
} from "./size-reuse/executor.js";
import { loadSizeReuseFixtureFile } from "./size-reuse/fixtures.js";
import {
  SEMA_TAX_REUSE_FACTORS,
  SEMA_TAX_SIZE_REUSE_PATTERN_COUNT,
  SEMA_TAX_SIZE_TIERS,
  semaTaxSizeReuseResultManifestSchema,
  semaTaxSizeReuseTrialRecordSchema,
  type SemaTaxSizeReuseTrialRecord,
} from "./size-reuse/schemas.js";
import {
  sizeReuseSummaryMarkdown,
  summarizeSizeReuse,
} from "./size-reuse/summary.js";
import { semaTaxSummaryMarkdown, summarizeSemaTax } from "./summary.js";
import { runSimulatedTaxTrial } from "./tax.js";

const EXPERIMENT_ID = "sema-tax";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROMPTS_DIR = join(REPO_ROOT, "experiments/sema-tax/prompts");
const WORKSHEET_PROMPT_KEY = "worksheet-solver";

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL_PILOT_REPETITIONS = 5;
const DEFAULT_ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY";
const DEFAULT_OPENAI_KEY_ENV = "CHUTES_API_KEY";
const SUGGESTED_CHUTES_BASE_URL = "https://llm.chutes.ai/v1";
const MAX_CONCURRENCY = 32;

type RunMode = "deterministic" | "model-pilot";
type ModelProvider = "anthropic" | "openai-compatible";
type ExperimentArm = "default" | "size-reuse";

const DEFAULT_FIXTURE_RELATIVE =
  "experiments/sema-tax/fixtures/worksheets.yaml";
const SIZE_REUSE_FIXTURE_RELATIVE =
  "experiments/sema-tax/fixtures/worksheets-size-reuse.yaml";

interface CliOptions {
  arm: ExperimentArm;
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
  thinking: AnthropicThinkingMode;
  maxTokens: number;
  concurrency: number;
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
    "Usage: pnpm experiment:sema-tax -- [options]",
    "",
    "Options:",
    "  --arm <a>           default (31-condition tax curve) or size-reuse",
    "                      (ADR 0013: 27-condition size x reuse grid at p8 cold)",
    "  --mode <m>          deterministic or model-pilot (default: deterministic)",
    "  --fixtures <path>   YAML worksheet fixture file (arm-specific default)",
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
    "model-pilot mode requires the selected provider's API key env var to be set.",
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
    arm: "default",
    mode: "deterministic",
    fixturePath: join(REPO_ROOT, DEFAULT_FIXTURE_RELATIVE),
    outputRoot: join(REPO_ROOT, "results/sema-tax"),
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
  let fixtureExplicit = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--arm") {
      const arm = args[++index];
      if (arm !== "default" && arm !== "size-reuse") {
        throw new Error(`${argument} requires default or size-reuse.`);
      }
      options.arm = arm;
      continue;
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
      fixtureExplicit = true;
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

  if (options.mode === "model-pilot" && !options.seedCountExplicit) {
    options.seedCount = DEFAULT_MODEL_PILOT_REPETITIONS;
  }

  // The size/reuse arm ships its own fixture catalog; use it unless the caller
  // named a fixture explicitly.
  if (options.arm === "size-reuse" && !fixtureExplicit) {
    options.fixturePath = join(REPO_ROOT, SIZE_REUSE_FIXTURE_RELATIVE);
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

function requireWorksheetPrompt(snapshot: PromptSnapshot): string {
  const prompt = snapshot.prompts[WORKSHEET_PROMPT_KEY];
  if (!prompt) {
    throw new Error(
      `Prompt snapshot is missing the ${WORKSHEET_PROMPT_KEY} prompt.`,
    );
  }
  return prompt.content;
}

function createModelAdapter(
  snapshot: PromptSnapshot,
  options: CliOptions,
): ModelAgentAdapter<ModelPromptInput, ModelCompletion> {
  const systemPrompt = requireWorksheetPrompt(snapshot);
  return options.provider === "openai-compatible"
    ? new OpenAiCompatibleModelAdapter({
        systemPrompt,
        baseUrl: options.baseUrl,
        apiKeyEnvVar: options.apiKeyEnv,
        model: options.model,
        maxTokens: options.maxTokens,
      })
    : new AnthropicModelAdapter({
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

function trialProgressLine(
  record: SemaTaxTrialRecord,
  done: number,
  total: number,
): string {
  const elapsed = (record.metrics.elapsedMs / 1000).toFixed(1);
  const calls = record.usage?.attempts ?? 0;
  return (
    `trial ${done}/${total} ${record.scenarioId} ${record.condition} ` +
    `seed=${record.seed} -> score=${record.metrics.score.toFixed(2)} ` +
    `tok=${record.metrics.totalModelTokens} (${elapsed}s, ${calls} calls)`
  );
}

/**
 * Runs the size/reuse follow-up arm (ADR 0013): a 27-condition grid crossing
 * three definition size tiers with three reuse factors and three delivery arms,
 * at the fixed p8 cold pattern count. Each trial is R sequential worksheet
 * messages in one conversation. Structurally parallels {@link main}'s default
 * arm but uses the size/reuse fixtures, conditions, executors, schemas, and
 * summary, and writes a bundle with its own distinct fixture digest.
 */
async function runSizeReuseArm(options: CliOptions): Promise<void> {
  let concurrency = options.concurrency;
  if (options.mode !== "model-pilot" && concurrency > 1) {
    console.error(
      `Note: --concurrency ${concurrency} is ignored in deterministic mode; running sequentially.`,
    );
    concurrency = 1;
  }

  const { fixtureDigest, fixtureSet, patternsByHandle } =
    await loadSizeReuseFixtureFile(options.fixturePath);
  const conditions = buildSizeReuseConditions();

  let promptSnapshot: PromptSnapshot | undefined;
  let adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion> | undefined;
  const isModelPilot = options.mode === "model-pilot";
  if (isModelPilot) {
    promptSnapshot = await loadPromptSnapshot(PROMPTS_DIR);
    adapter = createModelAdapter(promptSnapshot, options);
    const scenarioCount = fixtureSet.scenarios.length;
    const trialCount = scenarioCount * conditions.length * options.seedCount;
    // Each condition's R sequential messages; summed over the grid per block.
    const messagesPerBlock = conditions.reduce(
      (total, condition) => total + parseSizeReuseCondition(condition).reuse,
      0,
    );
    const messageCount = scenarioCount * options.seedCount * messagesPerBlock;
    console.log(
      "Sema tax size/reuse arm model pilot (exploratory, not confirmatory).",
    );
    console.log(
      `Planned: ${scenarioCount} scenarios x ${conditions.length} conditions x ` +
        `${options.seedCount} repetitions = ${trialCount} trials ` +
        `(each an R-message conversation; ~${messageCount} model calls).`,
    );
  }

  const referenceProvider = createReferenceProvider(options);
  const semanticMetadata = await referenceProvider.metadata();
  const seeds = Array.from({ length: options.seedCount }, (_, index) => index);

  const promptDigest =
    isModelPilot && promptSnapshot
      ? promptSnapshot.promptDigest
      : fingerprint({
          experiment: EXPERIMENT_ID,
          protocolVersion: PROTOCOL_VERSION,
          policy: "deterministic-sema-tax-size-reuse-simulator-v1",
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
    vocabularyRoot: process.env.SEMA_VOCABULARY_ROOT ?? "",
    semanticBackend: semanticMetadata.backend,
    modelProvider: isModelPilot
      ? options.provider === "openai-compatible"
        ? options.host
        : "anthropic"
      : (process.env.MODEL_PROVIDER ?? "deterministic"),
    modelName: isModelPilot
      ? options.model
      : (process.env.MODEL_NAME ?? "sema-tax-simulator-v1"),
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

  const records = await executeMatrix<
    (typeof cells)[number]["scenario"],
    (typeof cells)[number]["condition"],
    SemaTaxSizeReuseTrialRecord
  >(
    cells,
    (cell) => {
      if (isModelPilot && adapter) {
        return runModelSizeReuseTrial(cell, {
          experimentId: EXPERIMENT_ID,
          referenceProvider,
          patternsByHandle,
          provenance,
          adapter,
        });
      }
      return runSimulatedSizeReuseTrial(cell, {
        experimentId: EXPERIMENT_ID,
        referenceProvider,
        patternsByHandle,
        provenance,
      });
    },
    { concurrency },
  );

  const createdAt = new Date();
  const runId = `${timestampId(createdAt)}-size-reuse-order-${options.orderSeed}`;
  const outputDirectory = join(options.outputRoot, runId);
  const bundle = await writeResultBundleWith(
    outputDirectory,
    {
      artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      experimentId: EXPERIMENT_ID,
      runId,
      arm: "size-reuse" as const,
      mode: isModelPilot ? "model-pilot" : "deterministic-harness",
      evidenceClaim: isModelPilot
        ? "Exploratory model pilot of the size/reuse arm (ADR 0013). Not preregistered, not confirmatory evidence. Provider cached-token telemetry is observational only (ADR 0011); the reported tokens are a growing multi-turn conversation."
        : "Validates the size/reuse condition grid, per-message and cumulative byte/token accounting, one-time resolver hydration, the size-tier byte bands, scoring, randomization, and reporting only. Deterministic outcomes and token prices are scripted; the token model attributes each definition ingestion once per wire delivery (see ADR 0013).",
      createdAt: createdAt.toISOString(),
      orderSeed: options.orderSeed,
      seeds,
      conditions,
      patternCount: SEMA_TAX_SIZE_REUSE_PATTERN_COUNT,
      sizes: [...SEMA_TAX_SIZE_TIERS],
      reuseFactors: [...SEMA_TAX_REUSE_FACTORS],
      scenarioCount: fixtureSet.scenarios.length,
      trialCount: records.length,
      fixtureDigest,
      provenance,
    },
    records,
    {
      manifestSchema: semaTaxSizeReuseResultManifestSchema,
      recordSchema: semaTaxSizeReuseTrialRecordSchema,
      summarize: summarizeSizeReuse,
      renderMarkdown: sizeReuseSummaryMarkdown,
    },
  );

  const summary = summarizeSizeReuse(records);
  console.log(
    `Sema tax size/reuse arm completed: ${summary.trialCount} trials.`,
  );
  console.log(
    `Semantic backend: ${semanticMetadata.backend} (${semanticMetadata.semaVersion}, ${semanticMetadata.canonicalizationVersion})`,
  );
  console.log(`Result bundle: ${bundle.directory}`);
  for (const condition of summary.conditions) {
    console.log(
      `${condition.condition.padEnd(28)} score=${condition.meanScore.toFixed(3)} ` +
        `semB=${condition.meanTotalSemanticBytes.toFixed(0)} ` +
        `tok=${condition.meanTotalModelTokens.toFixed(0)} ` +
        `score/1kB=${condition.scorePerKSemanticByte.toFixed(4)}`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.mode === "model-pilot") {
    assertProviderApiKey(options);
  }

  if (options.arm === "size-reuse") {
    await runSizeReuseArm(options);
    return;
  }

  let concurrency = options.concurrency;
  if (options.mode !== "model-pilot" && concurrency > 1) {
    console.error(
      `Note: --concurrency ${concurrency} is ignored in deterministic mode; running sequentially.`,
    );
    concurrency = 1;
  }

  const { fixtureDigest, fixtureSet, patternsByHandle } = await loadFixtureFile(
    options.fixturePath,
  );
  const conditions = buildConditions();

  let promptSnapshot: PromptSnapshot | undefined;
  let adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion> | undefined;
  const isModelPilot = options.mode === "model-pilot";
  if (isModelPilot) {
    promptSnapshot = await loadPromptSnapshot(PROMPTS_DIR);
    adapter = createModelAdapter(promptSnapshot, options);

    const scenarioCount = fixtureSet.scenarios.length;
    const trialCount = scenarioCount * conditions.length * options.seedCount;
    console.log("Sema tax curve model pilot (exploratory, not confirmatory).");
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
      `Planned: ${scenarioCount} scenarios x ${conditions.length} conditions x ` +
        `${options.seedCount} repetitions = ${trialCount} trials, ` +
        `${trialCount} model calls (one worksheet call each).`,
    );
    console.log(
      concurrency > 1
        ? `Concurrency: up to ${concurrency} trials in flight (started in planned order).`
        : "Concurrency: 1 (sequential).",
    );
  }

  const referenceProvider = createReferenceProvider(options);
  const semanticMetadata = await referenceProvider.metadata();
  const seeds = Array.from({ length: options.seedCount }, (_, index) => index);

  const promptDigest =
    isModelPilot && promptSnapshot
      ? promptSnapshot.promptDigest
      : fingerprint({
          experiment: EXPERIMENT_ID,
          protocolVersion: PROTOCOL_VERSION,
          policy: "deterministic-sema-tax-simulator-v1",
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
    vocabularyRoot: process.env.SEMA_VOCABULARY_ROOT ?? "",
    semanticBackend: semanticMetadata.backend,
    modelProvider: isModelPilot
      ? options.provider === "openai-compatible"
        ? options.host
        : "anthropic"
      : (process.env.MODEL_PROVIDER ?? "deterministic"),
    modelName: isModelPilot
      ? options.model
      : (process.env.MODEL_NAME ?? "sema-tax-simulator-v1"),
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
  if (isModelPilot) {
    console.error(`Running ${total} trials, concurrency ${concurrency}...`);
  }

  const records = await executeMatrix<
    (typeof cells)[number]["scenario"],
    (typeof cells)[number]["condition"],
    SemaTaxTrialRecord
  >(
    cells,
    (cell) => {
      if (isModelPilot && adapter) {
        return runModelTaxTrial(cell, {
          experimentId: EXPERIMENT_ID,
          referenceProvider,
          patternsByHandle,
          provenance,
          adapter,
        });
      }
      return runSimulatedTaxTrial(cell, {
        experimentId: EXPERIMENT_ID,
        referenceProvider,
        patternsByHandle,
        provenance,
      });
    },
    {
      concurrency,
      ...(isModelPilot
        ? {
            onComplete: (record: SemaTaxTrialRecord): void => {
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
      experimentId: EXPERIMENT_ID,
      runId,
      mode: isModelPilot ? "model-pilot" : "deterministic-harness",
      evidenceClaim: isModelPilot
        ? "Exploratory model pilot. Not preregistered, not confirmatory evidence. Provider cached-token telemetry is observational only: the cold/warm axis controls harness-level hydration bytes, not the provider's automatic prompt-prefix caching, which may be active in both arms (see ADR 0011)."
        : "Validates the tax-curve condition matrix, byte/token accounting, hydration cold/warm split, scoring, randomization, and reporting only. Deterministic outcomes and token prices are scripted, and the simulated cached-token accounting models an idealized provider (see ADR 0011).",
      createdAt: createdAt.toISOString(),
      orderSeed: options.orderSeed,
      seeds,
      conditions,
      patternCounts: [...SEMA_TAX_PATTERN_COUNTS],
      scenarioCount: fixtureSet.scenarios.length,
      trialCount: records.length,
      fixtureDigest,
      provenance,
    },
    records,
    {
      manifestSchema: semaTaxResultManifestSchema,
      recordSchema: semaTaxTrialRecordSchema,
      summarize: summarizeSemaTax,
      renderMarkdown: semaTaxSummaryMarkdown,
    },
  );

  const summary = summarizeSemaTax(records);
  console.log(`Sema tax curve completed: ${summary.trialCount} trials.`);
  console.log(
    `Semantic backend: ${semanticMetadata.backend} (${semanticMetadata.semaVersion}, ${semanticMetadata.canonicalizationVersion})`,
  );
  console.log(`Result bundle: ${bundle.directory}`);
  for (const condition of summary.conditions) {
    console.log(
      `${condition.condition.padEnd(20)} score=${condition.meanScore.toFixed(3)} ` +
        `tok=${condition.meanTotalModelTokens.toFixed(0)} ` +
        `score/1k=${condition.scorePerKToken.toFixed(4)}`,
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
