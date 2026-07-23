import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MODEL_PROVIDER_NAMES,
  FixtureReferenceProvider,
  SemaPythonReferenceProvider,
  createModelProvider,
  isModelProvider,
  modelProviderRequiresApiKey,
  type AnthropicThinkingMode,
  type ModelProvider,
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
import {
  createResultJournalWith,
  writeResultBundleWith,
} from "@sema-evals/reporters";

import { buildConditions } from "./conditions.js";
import { runForecastingTrial } from "./demo.js";
import { loadFixtureFile } from "./fixtures.js";
import { buildLeakageAuditDocument } from "./leakage.js";
import { runModelForecastingTrial } from "./model-demo.js";
import {
  assertSemanticDriftsAddressable,
  evaluateModelLeakageAudit,
  loadHistoricalForecastingDataset,
  type LoadedEvidenceItem,
} from "./model-readiness.js";
import {
  forecastingResultManifestSchema,
  forecastingTrialRecordSchema,
  leakageAuditDocumentSchema,
  type ForecastingTrialRecord,
  type LeakageAuditDocument,
  type ForecastingInformationArm,
  type ForecastingScenario,
} from "./schemas.js";
import { forecastingSummaryMarkdown, summarizeForecasting } from "./summary.js";
import {
  FORECASTING_SCORER_FINGERPRINT,
  FORECASTING_SCORER_VERSION,
} from "./scoring.js";

const EXPERIMENT_ID = "forecasting";
const FORECASTING_POLICY =
  "deterministic-forecasting-council-demo-v2-canonical-aggregation";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface CliOptions {
  mode: "deterministic-harness" | "model-pilot";
  fixturePath: string;
  outputRoot: string;
  orderSeed: number;
  seedCount: number;
  semanticBackend: "fixture" | "sema-python";
  semaPython: string;
  datasetPath: string;
  leakageAuditPath: string;
  provider: ModelProvider;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  thinking: AnthropicThinkingMode;
  maxTokens: number;
  concurrency: number;
  informationArm: ForecastingInformationArm | "";
  pilotQuestions: number | null;
}

function usage(): string {
  return [
    "Usage: pnpm experiment:forecasting -- [options]",
    "",
    "Options:",
    "  --mode <m>          deterministic-harness or model-pilot",
    "  --fixtures <path>   YAML scenario fixture file",
    "  --output <path>     Result root directory",
    "  --order-seed <n>    Recorded randomization seed (default: 20260716)",
    "  --seeds <n>         Number of paired repetition seeds (default: 1)",
    "  --semantic-backend  fixture or sema-python (default: fixture)",
    "  --sema-python <cmd> Python executable with semahash installed",
    "  --dataset <path>    Frozen historical dataset (model-pilot only)",
    "  --information-arm <a> Require no-evidence-v1 or frozen-market-signal-v1",
    "  --pilot-questions <n> First n unique frozen questions after full audit validation",
    "  --leakage-audit <p> Model-specific zero-evidence audit (model-pilot only)",
    `  --provider <p>      ${MODEL_PROVIDER_NAMES} (default: anthropic)`,
    "  --base-url <url>    OpenAI-compatible endpoint base URL",
    "  --api-key-env <n>   Key environment variable for API providers",
    "  --model <id>        Model id",
    "  --thinking <m>      adaptive or none (anthropic only; default adaptive)",
    "  --max-tokens <n>    Max output tokens (default 1024)",
    "  --concurrency <n>   Maximum trials in flight (default 1)",
    "  --help              Show this help",
    "",
    "Model pilot is exploratory and requires a validated historical dataset and model-specific leakage audit.",
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
      "experiments/forecasting/fixtures/scenarios.yaml",
    ),
    outputRoot: join(REPO_ROOT, "results/forecasting"),
    orderSeed: 20_260_716,
    seedCount: 1,
    semanticBackend: "fixture",
    semaPython: resolveFromRepoRoot(process.env.SEMA_PYTHON ?? "python3"),
    datasetPath: join(
      REPO_ROOT,
      "experiments/forecasting/datasets/acquired/historical-resolved-v1.yaml",
    ),
    leakageAuditPath: "",
    provider: "anthropic",
    baseUrl: "",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-5",
    thinking: "adaptive",
    maxTokens: 1024,
    concurrency: 1,
    informationArm: "",
    pilotQuestions: null,
  };
  let modelExplicit = false;
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
      if (mode !== "deterministic-harness" && mode !== "model-pilot")
        throw new Error(
          `${argument} requires deterministic-harness or model-pilot.`,
        );
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
    if (argument === "--dataset") {
      options.datasetPath = resolve(REPO_ROOT, args[++index] ?? "");
      continue;
    }
    if (argument === "--leakage-audit") {
      options.leakageAuditPath = resolve(REPO_ROOT, args[++index] ?? "");
      continue;
    }
    if (argument === "--information-arm") {
      const arm = args[++index];
      if (arm !== "no-evidence-v1" && arm !== "frozen-market-signal-v1") {
        throw new Error(
          `${argument} requires no-evidence-v1 or frozen-market-signal-v1.`,
        );
      }
      options.informationArm = arm;
      continue;
    }
    if (argument === "--pilot-questions") {
      options.pilotQuestions = positiveInteger(args[++index], argument);
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
      options.baseUrl = args[++index] ?? "";
      continue;
    }
    if (argument === "--api-key-env") {
      options.apiKeyEnv = args[++index] ?? "";
      apiKeyEnvExplicit = true;
      continue;
    }
    if (argument === "--model") {
      options.model = args[++index] ?? "";
      modelExplicit = true;
      continue;
    }
    if (argument === "--thinking") {
      const thinking = args[++index];
      if (thinking !== "adaptive" && thinking !== "none")
        throw new Error(`${argument} requires adaptive or none.`);
      options.thinking = thinking;
      continue;
    }
    if (argument === "--max-tokens") {
      options.maxTokens = positiveInteger(args[++index], argument);
      continue;
    }
    if (argument === "--concurrency") {
      options.concurrency = positiveInteger(args[++index], argument);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }

  if (options.mode === "model-pilot") {
    if (!options.leakageAuditPath)
      throw new Error(
        "model-pilot requires --leakage-audit produced for the selected model.",
      );
    if (options.provider === "openai-compatible") {
      if (!options.baseUrl)
        throw new Error(
          "--base-url is required for provider openai-compatible.",
        );
      if (!modelExplicit || !options.model)
        throw new Error("--model is required for provider openai-compatible.");
      if (!apiKeyEnvExplicit) options.apiKeyEnv = "CHUTES_API_KEY";
    }
  }
  return options;
}

function assertProviderApiKey(options: CliOptions): void {
  if (
    options.mode === "model-pilot" &&
    modelProviderRequiresApiKey(options.provider) &&
    !process.env[options.apiKeyEnv]
  ) {
    throw new Error(
      `model-pilot mode with provider ${options.provider} requires ${options.apiKeyEnv} to be set.`,
    );
  }
}

function modelSystemPrompt(informationArm: ForecastingInformationArm): string {
  const informationPolicy =
    informationArm === "no-evidence-v1"
      ? "This is the registered no-evidence arm: use only the supplied question, resolution criteria, and local ResolutionDefinition."
      : "Use only the supplied question, resolution criteria, local ResolutionDefinition, and frozen pre-cutoff evidence.";
  return `You are one independent member of a forecasting council in a registered historical replay. ${informationPolicy} Do not use post-cutoff information. Forecast the probability of YES under your local ResolutionDefinition, not an assumed source-market convention. Return exactly one JSON object: {"agentId": string, "probability": number from 0 through 1, "rationale": string}.`;
}

/** Select complete drift/control pairs only, preserving the dataset's frozen order. */
export function selectPilotScenarios(
  scenarios: readonly ForecastingScenario[],
  pilotQuestions: number | null,
): ForecastingScenario[] {
  if (pilotQuestions === null) return [...scenarios];
  const selectedQuestions = new Set<string>();
  for (const scenario of scenarios) {
    if (selectedQuestions.size === pilotQuestions) break;
    selectedQuestions.add(scenario.question.questionText);
  }
  if (selectedQuestions.size !== pilotQuestions) {
    throw new Error(
      `--pilot-questions requested ${pilotQuestions}, but dataset contains only ${selectedQuestions.size} unique questions.`,
    );
  }
  return scenarios.filter((scenario) =>
    selectedQuestions.has(scenario.question.questionText),
  );
}

export function assertInformationArm(
  requested: ForecastingInformationArm | "",
  actual: ForecastingInformationArm,
): void {
  if (actual === "frozen-market-signal-v1" && !requested) {
    throw new Error(
      "frozen-market-signal-v1 requires explicit --information-arm frozen-market-signal-v1.",
    );
  }
  if (requested && requested !== actual) {
    throw new Error(
      `--information-arm ${requested} does not match dataset arm ${actual}.`,
    );
  }
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

export async function runForecastingCli(
  args: readonly string[],
): Promise<string> {
  const options = parseArgs(args);
  const isModelRun = options.mode === "model-pilot";
  assertProviderApiKey(options);
  let fixtureDigest: string;
  let scenarios: Awaited<
    ReturnType<typeof loadFixtureFile>
  >["fixtureSet"]["scenarios"];
  let driftScenarioCount: number;
  let cleanScenarioCount: number;
  let datasetDigest: string | null = null;
  let leakageAuditFingerprint: string | null = null;
  let evidencePackFingerprint: string | null = null;
  let informationArm: ForecastingInformationArm | null = null;
  let questionSetFingerprint: string | null = null;
  let selectedModelLeakageAudit: LeakageAuditDocument | null = null;
  let modelProviderLabel: string | null = null;
  let modelAdapter: ReturnType<typeof createModelProvider>["adapter"] | null =
    null;
  let evidenceByScenario: ReadonlyMap<
    string,
    readonly LoadedEvidenceItem[]
  > | null = null;
  if (isModelRun) {
    const historical = await loadHistoricalForecastingDataset(
      options.datasetPath,
    );
    datasetDigest = historical.digest;
    informationArm = historical.dataset.informationArm;
    evidencePackFingerprint = historical.evidencePackFingerprint;
    questionSetFingerprint = historical.questionSetFingerprint;
    evidenceByScenario = historical.evidenceByScenario;
    assertInformationArm(options.informationArm, informationArm);
    const created = createModelProvider({
      provider: options.provider,
      systemPrompt: modelSystemPrompt(informationArm),
      model: options.model,
      maxTokens: options.maxTokens,
      thinking: options.thinking,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
    });
    modelAdapter = created.adapter;
    modelProviderLabel = await created.providerLabel();
    const auditInput = JSON.parse(
      await readFile(options.leakageAuditPath, "utf8"),
    ) as unknown;
    const audit = evaluateModelLeakageAudit(
      auditInput,
      {
        modelDescriptor: `${modelProviderLabel}/${options.model}`,
        datasetDigest,
        informationArm,
        evidencePackFingerprint,
        questionSetFingerprint,
      },
      historical.dataset.scenarios.map((scenario) => scenario.id),
    );
    if (!audit.passed)
      throw new Error(
        `Model-pilot readiness gate failed: ${audit.failures.join("; ")}`,
      );
    const auditsById = new Map(
      audit.document.entries.map((entry) => [entry.scenarioId, entry.audit]),
    );
    scenarios = selectPilotScenarios(
      historical.dataset.scenarios,
      options.pilotQuestions,
    ).map((scenario) => ({
      ...scenario,
      leakageAudit: auditsById.get(scenario.id) ?? scenario.leakageAudit,
    }));
    fixtureDigest = datasetDigest;
    driftScenarioCount = scenarios.filter(
      (scenario) => scenario.drift !== null,
    ).length;
    cleanScenarioCount = scenarios.length - driftScenarioCount;
    leakageAuditFingerprint = fingerprint(audit.document);
    selectedModelLeakageAudit = audit.document;
  } else {
    const loaded = await loadFixtureFile(options.fixturePath);
    fixtureDigest = loaded.fixtureDigest;
    scenarios = loaded.fixtureSet.scenarios;
    driftScenarioCount = loaded.driftScenarioCount;
    cleanScenarioCount = loaded.cleanScenarioCount;
  }
  const conditions = buildConditions();

  const referenceProvider = createReferenceProvider(options);
  const semanticMetadata = await referenceProvider.metadata();
  if (isModelRun) {
    await assertSemanticDriftsAddressable(scenarios, referenceProvider);
  }
  const vocabularyRoot = process.env.SEMA_VOCABULARY_ROOT ?? "";
  const seeds = Array.from({ length: options.seedCount }, (_, index) => index);

  const promptDigest = isModelRun
    ? sha256Text(modelSystemPrompt(informationArm ?? "no-evidence-v1"))
    : fingerprint({
        experiment: EXPERIMENT_ID,
        protocolVersion: PROTOCOL_VERSION,
        policy: FORECASTING_POLICY,
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
      ? (modelProviderLabel ?? options.provider)
      : (process.env.MODEL_PROVIDER ?? "deterministic"),
    modelName: isModelRun
      ? options.model
      : (process.env.MODEL_NAME ?? "forecasting-council-demo-v1"),
  };

  const cells = planPairedMatrix({
    experimentId: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    scenarios,
    scenarioId: (scenario) => scenario.id,
    conditions,
    seeds,
    orderSeed: options.orderSeed,
  });

  const preflightSummary = summarizeForecasting([], scenarios);
  const createdAt = new Date();
  const runId = `${timestampId(createdAt)}-order-${options.orderSeed}`;
  const outputDirectory = join(options.outputRoot, runId);
  const protocolFingerprint = fingerprint({
    experiment: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    policy: FORECASTING_POLICY,
    conditions,
    aggregationInterpretation: "canonical-probability-format",
    scorer: FORECASTING_SCORER_FINGERPRINT,
    informationArm,
    evidencePackFingerprint,
    selectedScenarioIds: scenarios.map((scenario) => scenario.id),
  });
  const manifest = forecastingResultManifestSchema.parse({
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    experimentId: EXPERIMENT_ID,
    runId,
    mode: options.mode,
    evidenceClaim: isModelRun
      ? "Exploratory model pilot. Not preregistered, not confirmatory evidence. Historical questions are replayed after a selected-model audit bound to the exact dataset and, for the frozen-market-signal arm, the exact retained evidence bytes. Model outputs are objectively JSON-parsed and scored against frozen outcomes. The pre-existing primary endpoint remains corrupted aggregation under controlled registry drift; Brier score is reported as the registered utility metric with mandatory market-prior and independent-agent baselines. Conditions make independent model calls with no condition label in the model request; sampling/provider variation remains a nuisance and is preserved, not attributed to Sema."
      : "Validates the forecasting-council scaffold: synthetic Polymarket-style questions, controlled per-agent registry drift, corrupted aggregation under baseline, voluntary detection, enforced exclusion, Brier baselines (market prior + independent-agent average), the no-drift false-exclusion guard, leakage-audit gate, condition pairing, and bundle/summary reproduction. Scripted-agent outcomes are a construction, not evidence about language models, and not evidence about live prediction markets (ADR 0017).",
    createdAt: createdAt.toISOString(),
    orderSeed: options.orderSeed,
    seeds,
    conditions,
    scenarioCount: scenarios.length,
    driftScenarioCount,
    cleanScenarioCount,
    trialCount: cells.length,
    fixtureDigest,
    leakageAuditPassed: preflightSummary.leakageAuditPassed,
    scorer: {
      version: FORECASTING_SCORER_VERSION,
      fingerprint: FORECASTING_SCORER_FINGERPRINT,
    },
    protocolFingerprint,
    runConfiguration: {
      mode: options.mode,
      seeds,
      orderSeed: options.orderSeed,
      semanticBackend: options.semanticBackend,
      policy: FORECASTING_POLICY,
      aggregationInterpretation: "canonical-probability-format",
      datasetDigest,
      questionSetFingerprint,
      leakageAuditFingerprint,
      provider: isModelRun
        ? (modelProviderLabel ?? options.provider)
        : undefined,
      model: isModelRun ? options.model : undefined,
      endpointHost:
        isModelRun && options.baseUrl ? new URL(options.baseUrl).host : null,
      concurrency: options.concurrency,
      informationArm: informationArm ?? undefined,
      evidencePackFingerprint,
      pilotQuestions: options.pilotQuestions,
    },
    provenance,
  });
  const journal = isModelRun
    ? await createResultJournalWith(outputDirectory, manifest, {
        manifestSchema: forecastingResultManifestSchema,
        recordSchema: forecastingTrialRecordSchema,
        summarize: (trialRecords) =>
          summarizeForecasting(trialRecords, scenarios),
        renderMarkdown: forecastingSummaryMarkdown,
      })
    : null;

  let records: ForecastingTrialRecord[];
  try {
    records = await executeMatrix(
      cells,
      (cell) =>
        isModelRun && modelAdapter
          ? runModelForecastingTrial(cell, {
              experimentId: EXPERIMENT_ID,
              referenceProvider,
              vocabularyRoot,
              provenance,
              adapter: modelAdapter,
              ...(isModelRun &&
              informationArm === "frozen-market-signal-v1" &&
              evidenceByScenario
                ? { evidenceByScenario }
                : {}),
            })
          : runForecastingTrial(cell, {
              experimentId: EXPERIMENT_ID,
              referenceProvider,
              vocabularyRoot,
              provenance,
            }),
      {
        concurrency: options.concurrency,
        ...(journal
          ? {
              onComplete: async (record: ForecastingTrialRecord) =>
                journal.append(record),
            }
          : {}),
      },
    );
  } catch (error) {
    if (journal) await journal.fail(error);
    throw error;
  }

  const summary = summarizeForecasting(records, scenarios);
  const bundle = journal
    ? await journal.finalize(records)
    : await writeResultBundleWith(outputDirectory, manifest, records, {
        manifestSchema: forecastingResultManifestSchema,
        recordSchema: forecastingTrialRecordSchema,
        summarize: (trialRecords) =>
          summarizeForecasting(trialRecords, scenarios),
        renderMarkdown: forecastingSummaryMarkdown,
      });

  const leakageDocument = isModelRun
    ? selectedModelLeakageAudit
    : buildLeakageAuditDocument(scenarios);
  if (!leakageDocument) {
    throw new Error(
      "model-pilot completed without a validated leakage audit document.",
    );
  }
  const leakagePath = join(bundle.directory, "leakage-audit.json");
  await writeFile(
    leakagePath,
    `${JSON.stringify(leakageAuditDocumentSchema.parse(leakageDocument), null, 2)}\n`,
    "utf8",
  );

  if (!summary.leakageAuditPassed) {
    throw new Error(
      `Leakage audit gate failed; failed result bundle preserved at ${bundle.directory}: ${summary.leakageAuditFailures.join("; ")}`,
    );
  }

  console.log(
    `Forecasting council demo completed: ${summary.trialCount} trials.`,
  );
  console.log(
    `Semantic backend: ${semanticMetadata.backend} (${semanticMetadata.semaVersion}, ${semanticMetadata.canonicalizationVersion})`,
  );
  console.log(`Leakage audit gate: PASSED`);
  console.log(`Result bundle: ${bundle.directory}`);
  for (const condition of summary.conditions) {
    console.log(
      `${condition.condition.padEnd(21)} ` +
        `corrupted=${(condition.corruptedAggregationRate * 100).toFixed(0)}% ` +
        `detected=${(condition.detectionRate * 100).toFixed(0)}% ` +
        `correctExcl=${condition.correctExclusions} falseExcl=${condition.falseExclusions}`,
    );
  }
  return bundle.directory;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  runForecastingCli(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
