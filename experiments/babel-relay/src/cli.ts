import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AnthropicModelAdapter,
  FixtureReferenceProvider,
  OpenAiCompatibleModelAdapter,
  SemaPythonRegistryClient,
  SemaPythonReferenceProvider,
  type AnthropicThinkingMode,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  EXPERIMENT_CONDITIONS,
  PROTOCOL_VERSION,
  executeMatrix,
  fingerprint,
  loadPromptSnapshot,
  planPairedMatrix,
  sha256Text,
  type PromptSnapshot,
  type RelayBoundary,
  type TrialProvenance,
  type TrialRecord,
} from "@sema-evals/core";
import { summarizeTrials, writeResultBundle } from "@sema-evals/reporters";

import { loadScenarioFile } from "./fixtures.js";
import { runModelRelayTrial, type ModelRelayAdapters } from "./model-relay.js";
import { prepareSemaRegistryRuntime } from "./registry-runtime.js";
import { runRelayTrial, type RelaySemanticRuntime } from "./relay.js";

const EXPERIMENT_ID = "babel-relay";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROMPTS_DIR = join(REPO_ROOT, "experiments/babel-relay/prompts");

const RELAY_BOUNDARIES = [
  "spec-to-plan",
  "plan-to-implementation",
  "implementation-to-audit",
] as const satisfies readonly RelayBoundary[];

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL_PILOT_REPETITIONS = 5;
const DEFAULT_ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY";
const DEFAULT_OPENAI_KEY_ENV = "CHUTES_API_KEY";
const SUGGESTED_CHUTES_BASE_URL = "https://llm.chutes.ai/v1";

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
 * unset. Presence-only: the value is never read beyond truthiness. Exported for
 * the CLI validation test seam.
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
    "Usage: pnpm experiment:babel -- [options]",
    "",
    "Options:",
    "  --mode <m>          deterministic or model-pilot (default: deterministic)",
    "  --fixtures <path>   YAML scenario file",
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
    "  --max-tokens <n>    Max output tokens per hop (default: 4096)",
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

function resolveFromRepoRoot(value: string): string {
  return /[\\/]/.test(value) ? resolve(REPO_ROOT, value) : value;
}

export function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    mode: "deterministic",
    fixturePath: join(
      REPO_ROOT,
      "experiments/babel-relay/fixtures/scenarios.yaml",
    ),
    outputRoot: join(REPO_ROOT, "results/babel-relay"),
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
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }

  if (options.mode === "model-pilot" && !options.seedCountExplicit) {
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

function requirePrompt(
  snapshot: PromptSnapshot,
  boundary: RelayBoundary,
): string {
  const prompt = snapshot.prompts[boundary];
  if (!prompt) {
    throw new Error(`Prompt snapshot is missing the ${boundary} boundary.`);
  }
  return prompt.content;
}

function createModelAdapters(
  snapshot: PromptSnapshot,
  options: CliOptions,
): ModelRelayAdapters {
  const build = (
    boundary: RelayBoundary,
  ): AnthropicModelAdapter | OpenAiCompatibleModelAdapter =>
    options.provider === "openai-compatible"
      ? new OpenAiCompatibleModelAdapter({
          systemPrompt: requirePrompt(snapshot, boundary),
          baseUrl: options.baseUrl,
          apiKeyEnvVar: options.apiKeyEnv,
          model: options.model,
          maxTokens: options.maxTokens,
        })
      : new AnthropicModelAdapter({
          systemPrompt: requirePrompt(snapshot, boundary),
          model: options.model,
          maxTokens: options.maxTokens,
          thinkingMode: options.thinking,
        });
  return {
    "spec-to-plan": build("spec-to-plan"),
    "plan-to-implementation": build("plan-to-implementation"),
    "implementation-to-audit": build("implementation-to-audit"),
  };
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

  // Fail fast before any work when a model pilot cannot authenticate.
  if (options.mode === "model-pilot") {
    assertProviderApiKey(options);
  }

  const { fixtureDigest, scenarioSet } = await loadScenarioFile(
    options.fixturePath,
  );

  let promptSnapshot: PromptSnapshot | undefined;
  let adapters: ModelRelayAdapters | undefined;
  if (options.mode === "model-pilot") {
    promptSnapshot = await loadPromptSnapshot(PROMPTS_DIR);
    adapters = createModelAdapters(promptSnapshot, options);

    const scenarioCount = scenarioSet.scenarios.length;
    const conditionCount = EXPERIMENT_CONDITIONS.length;
    const trialCount = scenarioCount * conditionCount * options.seedCount;
    const hopCount = RELAY_BOUNDARIES.length;
    console.log("Babel Relay model pilot (exploratory, not confirmatory).");
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
        `${options.seedCount} repetitions = ${trialCount} trials, ` +
        `up to ${trialCount * hopCount} model calls (${hopCount} hops each).`,
    );
    console.log("Enforced halts skip downstream hops, reducing actual calls.");
  }

  const referenceProvider = createReferenceProvider(options);
  let semanticRuntime: RelaySemanticRuntime | undefined;
  try {
    const registryClient =
      options.semanticBackend === "sema-python"
        ? new SemaPythonRegistryClient({
            pythonCommand: options.semaPython,
          })
        : undefined;
    if (registryClient) {
      semanticRuntime = await prepareSemaRegistryRuntime(
        scenarioSet.scenarios,
        registryClient,
      );
    }
    const semanticMetadata = registryClient
      ? await registryClient.metadata()
      : await referenceProvider.metadata();
    const seeds = Array.from(
      { length: options.seedCount },
      (_, index) => index,
    );
    const isModelPilot = options.mode === "model-pilot";
    const promptDigest =
      isModelPilot && promptSnapshot
        ? promptSnapshot.promptDigest
        : fingerprint({
            experiment: EXPERIMENT_ID,
            protocolVersion: PROTOCOL_VERSION,
            policy: "deterministic-relay-v2-registry-handshake",
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
      vocabularyRoot:
        semanticRuntime?.canonicalVocabularyRoot ??
        process.env.SEMA_VOCABULARY_ROOT ??
        "",
      semanticBackend: semanticMetadata.backend,
      modelProvider: isModelPilot
        ? options.provider === "openai-compatible"
          ? options.host
          : "anthropic"
        : (process.env.MODEL_PROVIDER ?? "deterministic"),
      modelName: isModelPilot
        ? options.model
        : (process.env.MODEL_NAME ?? "deterministic-relay-v1"),
    };

    await Promise.all(
      scenarioSet.scenarios.flatMap((scenario) => [
        referenceProvider.reference(
          scenario.contract.handle,
          scenario.contract.canonicalDefinition,
        ),
        referenceProvider.reference(
          scenario.contract.handle,
          scenario.contract.mutatedDefinition,
        ),
      ]),
    );

    const cells = planPairedMatrix({
      experimentId: EXPERIMENT_ID,
      protocolVersion: PROTOCOL_VERSION,
      scenarios: scenarioSet.scenarios,
      scenarioId: (scenario) => scenario.id,
      conditions: EXPERIMENT_CONDITIONS,
      seeds,
      orderSeed: options.orderSeed,
    });

    const records = await executeMatrix<
      (typeof cells)[number]["scenario"],
      (typeof cells)[number]["condition"],
      TrialRecord
    >(cells, (cell) => {
      if (isModelPilot && adapters) {
        return runModelRelayTrial(cell, {
          experimentId: EXPERIMENT_ID,
          referenceProvider,
          ...(semanticRuntime ? { semanticRuntime } : {}),
          provenance,
          adapters,
        });
      }
      return runRelayTrial(cell, {
        experimentId: EXPERIMENT_ID,
        referenceProvider,
        ...(semanticRuntime ? { semanticRuntime } : {}),
        provenance,
      });
    });
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
        mode: isModelPilot ? "model-pilot" : "deterministic-harness",
        evidenceClaim: isModelPilot
          ? "Exploratory model pilot. Not preregistered, not confirmatory evidence."
          : "Validates condition mechanics, drift scoring, randomization, and artifact reporting only.",
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
    console.log(
      `Semantic backend: ${semanticMetadata.backend} (${semanticMetadata.semaVersion}, ${semanticMetadata.canonicalizationVersion})`,
    );
    if (semanticRuntime) {
      console.log(
        `Canonical vocabulary root: ${semanticRuntime.canonicalVocabularyRoot}`,
      );
    }
    console.log(`Result bundle: ${bundle.directory}`);
    for (const condition of summary.conditions) {
      console.log(
        `${condition.condition.padEnd(20)} success=${(condition.taskSuccessRate * 100).toFixed(1)}% ` +
          `silent-drift=${(condition.silentDivergenceRate * 100).toFixed(1)}%`,
      );
    }
  } finally {
    await semanticRuntime?.cleanup();
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
