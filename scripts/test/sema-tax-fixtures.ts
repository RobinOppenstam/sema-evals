import type {
  SemaTaxMetrics,
  SemaTaxResultManifest,
  SemaTaxTrialRecord,
} from "../../experiments/sema-tax/src/schemas.js";

const HEX64 = "a".repeat(64);

const PROVENANCE = {
  artifactSchemaVersion: "0.3.0",
  protocolVersion: "0.3.0",
  fixtureDigest: HEX64,
  implementationCommit: "abc123",
  dependencyLockDigest: HEX64,
  promptDigest: HEX64,
  semaVersion: "not-connected",
  canonicalizationVersion: "fixture-stable-json-v1",
  vocabularyRoot: "",
  semanticBackend: "fixture-sha256-stable-json-v1",
  modelProvider: "llm.example",
  modelName: "example/model",
};

const BASE_METRICS: SemaTaxMetrics = {
  patternCount: 0,
  delivery: "baseline",
  cacheState: "none",
  activePatternCount: 0,
  itemsTotal: 4,
  itemsAnswered: 4,
  itemsCorrect: 2,
  score: 0.5,
  taskSuccess: false,
  wireBytes: 500,
  hydrationBytes: 0,
  totalContextBytes: 500,
  inputTokens: 500,
  cachedInputTokensRead: 490,
  outputTokens: 1000,
  reasoningTokens: null,
  totalModelTokens: 1500,
  costUsd: null,
  elapsedMs: 1000,
};

let counter = 0;

export interface SemaTaxTrialOptions {
  scenarioId: string;
  condition: string;
  seed: number;
  metrics: Partial<SemaTaxMetrics>;
  transcript?: SemaTaxTrialRecord["transcript"];
}

/** Build a schema-valid synthetic sema-tax trial record with controlled metrics. */
export function makeSemaTaxTrial(
  options: SemaTaxTrialOptions,
): SemaTaxTrialRecord {
  counter += 1;
  const suffix = counter.toString(16).padStart(4, "0");
  const trialId = `${HEX64.slice(0, 60)}${suffix}`;
  const metrics: SemaTaxMetrics = { ...BASE_METRICS, ...options.metrics };
  return {
    trialId,
    experimentId: "sema-tax",
    scenarioId: options.scenarioId,
    condition: options.condition,
    seed: options.seed,
    executionIndex: counter,
    startedAt: "2026-07-15T00:00:00.000Z",
    completedAt: "2026-07-15T00:00:01.000Z",
    events: [],
    metrics,
    provenance: PROVENANCE,
    usage: null,
    transcript: options.transcript ?? null,
  };
}

/** A transcript entry carrying a raw provider `chat.completion` payload. */
export function rawProviderTranscript(): SemaTaxTrialRecord["transcript"] {
  return {
    entries: [
      {
        index: 0,
        attempt: 0,
        role: "assistant",
        content: [
          {
            type: "text",
            text: "ITEM a: yes",
            toolName: null,
            toolInput: null,
          },
        ],
        raw: {
          id: "cmpl-1",
          object: "chat.completion",
          model: "example/model",
          chutes_verification: "secret-token",
        },
      },
    ],
  };
}

export function makeSemaTaxManifest(
  overrides: Partial<SemaTaxResultManifest> = {},
): SemaTaxResultManifest {
  return {
    artifactSchemaVersion: "0.3.0",
    protocolVersion: "0.3.0",
    experimentId: "sema-tax",
    runId: "20260715T103807828Z-order-20260714",
    mode: "model-pilot",
    evidenceClaim: "Exploratory model pilot. Not confirmatory evidence.",
    createdAt: "2026-07-15T10:38:07.828Z",
    orderSeed: 20260714,
    seeds: [0, 1],
    conditions: ["p0-baseline", "p16-content-warm"],
    patternCounts: [0, 16],
    scenarioCount: 1,
    trialCount: 2,
    fixtureDigest: HEX64,
    provenance: PROVENANCE,
    ...overrides,
  };
}
