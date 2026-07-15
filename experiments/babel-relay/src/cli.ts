import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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
import {
  DECISION_SCORER_VERSION,
  runModelRelayTrial,
  type ModelRelayAdapters,
} from "./model-relay.js";
import {
  loadPreregistration,
  verifyFreeze,
  type LoadedPreregistration,
} from "./preregistration.js";
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
const MAX_CONCURRENCY = 32;

/** Modes that invoke a model provider (as opposed to the deterministic relay).
 * Confirmatory mode executes exactly like a model pilot; it adds the freeze
 * check and preregistration provenance around the same run. */
export function runsModels(mode: RunMode): boolean {
  return mode === "model-pilot" || mode === "confirmatory";
}

type RunMode = "deterministic" | "model-pilot" | "confirmatory";
type ModelProvider = "anthropic" | "openai-compatible";

interface CliOptions {
  mode: RunMode;
  /** Preregistration markdown path; required by (and only valid in) confirmatory
   * mode. Its pins are verified against the loaded artifacts before any run. */
  preregistrationPath: string;
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
    "  --mode <m>          deterministic, model-pilot, or confirmatory",
    "                      (default: deterministic)",
    "  --preregistration <path>",
    "                      Preregistration markdown; required by and only valid",
    "                      with --mode confirmatory. Freeze-checked before any run.",
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
    mode: "deterministic",
    preregistrationPath: "",
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
      if (
        mode !== "deterministic" &&
        mode !== "model-pilot" &&
        mode !== "confirmatory"
      ) {
        throw new Error(
          `${argument} requires deterministic, model-pilot, or confirmatory.`,
        );
      }
      options.mode = mode;
      continue;
    }
    if (argument === "--preregistration") {
      const path = args[++index];
      if (!path) {
        throw new Error(
          `${argument} requires a path to a preregistration file.`,
        );
      }
      options.preregistrationPath = resolve(REPO_ROOT, path);
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

  if (options.mode === "confirmatory" && !options.preregistrationPath) {
    throw new Error(
      "--mode confirmatory requires --preregistration <path> so the run's frozen artifacts can be verified against the registration.",
    );
  }
  if (options.mode !== "confirmatory" && options.preregistrationPath) {
    throw new Error(
      "--preregistration is only valid with --mode confirmatory.",
    );
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

/**
 * One human-readable progress line per completed trial, written to stderr so
 * stdout stays reserved for the machine-parseable summary. `calls` counts the
 * provider attempts recorded across the trial's model hops (retries included);
 * a trial that halted before any model hop has no usage and reports zero.
 */
function trialProgressLine(
  record: TrialRecord,
  done: number,
  total: number,
): string {
  const elapsed = (record.metrics.elapsedMs / 1000).toFixed(1);
  const calls = record.usage?.attempts ?? 0;
  const outcome = record.metrics.taskSuccess ? "taskSuccess" : "fail";
  return (
    `trial ${done}/${total} ${record.scenarioId} ${record.condition} ` +
    `seed=${record.seed} -> ${record.actualAction} [${outcome}] ` +
    `(${elapsed}s, ${calls} calls)`
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const isModelRun = runsModels(options.mode);
  const isConfirmatory = options.mode === "confirmatory";

  // Fail fast before any work when a model run cannot authenticate.
  if (isModelRun) {
    assertProviderApiKey(options);
  }

  // A confirmatory run's pins are parsed up front so a malformed or unreadable
  // preregistration fails before any fixture or model work begins.
  let preregistration: LoadedPreregistration | undefined;
  if (isConfirmatory) {
    preregistration = await loadPreregistration(options.preregistrationPath);
  }

  // Concurrency only helps when trials wait on a network provider. Deterministic
  // runs are local and CPU-bound; run them sequentially and note the override.
  let concurrency = options.concurrency;
  if (!isModelRun && concurrency > 1) {
    console.error(
      `Note: --concurrency ${concurrency} is ignored in deterministic mode; running sequentially.`,
    );
    concurrency = 1;
  }

  const { fixtureDigest, scenarioSet } = await loadScenarioFile(
    options.fixturePath,
  );

  let promptSnapshot: PromptSnapshot | undefined;
  let adapters: ModelRelayAdapters | undefined;
  if (isModelRun) {
    promptSnapshot = await loadPromptSnapshot(PROMPTS_DIR);
    adapters = createModelAdapters(promptSnapshot, options);

    const scenarioCount = scenarioSet.scenarios.length;
    const conditionCount = EXPERIMENT_CONDITIONS.length;
    const trialCount = scenarioCount * conditionCount * options.seedCount;
    const hopCount = RELAY_BOUNDARIES.length;
    console.log(
      isConfirmatory
        ? "Babel Relay CONFIRMATORY run (preregistered)."
        : "Babel Relay model pilot (exploratory, not confirmatory).",
    );
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
    console.log(
      concurrency > 1
        ? `Concurrency: up to ${concurrency} trials in flight (started in planned order).`
        : "Concurrency: 1 (sequential).",
    );
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
    const promptDigest =
      isModelRun && promptSnapshot
        ? promptSnapshot.promptDigest
        : fingerprint({
            experiment: EXPERIMENT_ID,
            protocolVersion: PROTOCOL_VERSION,
            policy: "deterministic-relay-v2-registry-handshake",
          });
    const implementationCommit = gitRevision();
    const provenance: TrialProvenance = {
      artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      fixtureDigest,
      implementationCommit,
      dependencyLockDigest: await fileDigest(join(REPO_ROOT, "pnpm-lock.yaml")),
      promptDigest,
      semaVersion: semanticMetadata.semaVersion,
      canonicalizationVersion: semanticMetadata.canonicalizationVersion,
      vocabularyRoot:
        semanticRuntime?.canonicalVocabularyRoot ??
        process.env.SEMA_VOCABULARY_ROOT ??
        "",
      semanticBackend: semanticMetadata.backend,
      modelProvider: isModelRun
        ? options.provider === "openai-compatible"
          ? options.host
          : "anthropic"
        : (process.env.MODEL_PROVIDER ?? "deterministic"),
      modelName: isModelRun
        ? options.model
        : (process.env.MODEL_NAME ?? "deterministic-relay-v1"),
      ...(isConfirmatory && preregistration
        ? {
            preregistrationPath: relative(
              REPO_ROOT,
              options.preregistrationPath,
            ),
            preregistrationDigest: preregistration.documentDigest,
          }
        : {}),
    };

    // Freeze verification: the confirmatory run refuses to make a single model
    // call unless every registered pin matches the artifacts just loaded and the
    // tree is clean. This runs after provenance is assembled (so we have the
    // resolved commit and digests) and before executeMatrix touches a provider.
    if (isConfirmatory && preregistration) {
      verifyFreeze(preregistration, {
        fixtureDigest,
        promptDigest,
        scorerVersion: DECISION_SCORER_VERSION,
        orderSeed: options.orderSeed,
        implementationCommit,
      });
      console.log(
        `Freeze check passed against ${provenance.preregistrationPath} ` +
          `(digest ${preregistration.documentDigest.slice(0, 12)}...).`,
      );
    }

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

    const total = cells.length;
    let completed = 0;
    if (isModelRun) {
      console.error(`Running ${total} trials, concurrency ${concurrency}...`);
    }
    const records = await executeMatrix<
      (typeof cells)[number]["scenario"],
      (typeof cells)[number]["condition"],
      TrialRecord
    >(
      cells,
      (cell) => {
        if (isModelRun && adapters) {
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
      },
      {
        concurrency,
        ...(isModelRun
          ? {
              onComplete: (record: TrialRecord): void => {
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
    const bundle = await writeResultBundle(
      outputDirectory,
      {
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        experimentId: EXPERIMENT_ID,
        runId,
        mode: isConfirmatory
          ? "confirmatory"
          : isModelRun
            ? "model-pilot"
            : "deterministic-harness",
        evidenceClaim: isConfirmatory
          ? "Preregistered confirmatory experiment. Hypotheses, sample size, exclusions, and analysis were fixed at registration; see the preregistration digest in provenance."
          : isModelRun
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
