import {
  type ExperimentCondition,
  type TrialMetrics,
  type TrialRecord,
} from "../../packages/core/src/schemas.js";

const HEX64 = "a".repeat(64);

const BASE_METRICS: TrialMetrics = {
  driftInjected: false,
  driftDetected: false,
  halted: false,
  silentDivergence: false,
  correctHalt: false,
  falseHalt: false,
  taskSuccess: false,
  detectionBoundary: null,
  wireBytes: 100,
  hydrationBytes: 0,
  totalSemanticBytes: 100,
  elapsedMs: 10,
};

export interface TrialOptions {
  scenarioId: string;
  condition: ExperimentCondition;
  seed: number;
  metrics: Partial<TrialMetrics>;
  transcript?: TrialRecord["transcript"];
}

let counter = 0;

/** Build a schema-valid synthetic trial record with controlled metrics. */
export function makeTrial(options: TrialOptions): TrialRecord {
  counter += 1;
  const suffix = counter.toString(16).padStart(4, "0");
  const trialId = `${HEX64.slice(0, 60)}${suffix}`;
  const metrics: TrialMetrics = { ...BASE_METRICS, ...options.metrics };
  return {
    trialId,
    experimentId: "babel-relay",
    scenarioId: options.scenarioId,
    condition: options.condition,
    seed: options.seed,
    executionIndex: counter,
    startedAt: "2026-07-14T00:00:00.000Z",
    completedAt: "2026-07-14T00:00:01.000Z",
    expectedAction: metrics.driftInjected ? "halt" : "proceed",
    actualAction: metrics.halted ? "halt" : "proceed",
    events: [],
    metrics,
    provenance: {
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
    },
    usage: null,
    transcript: options.transcript ?? null,
  };
}
