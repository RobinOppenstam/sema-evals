import { z } from "zod";

export const PROTOCOL_VERSION = "0.3.0";
export const ARTIFACT_SCHEMA_VERSION = "0.3.0";

export const EXPERIMENT_CONDITIONS = [
  "baseline",
  "equal-prose",
  "opaque-resolver",
  "addressed-voluntary",
  "addressed-enforced",
] as const;

export const experimentConditionSchema = z.enum(EXPERIMENT_CONDITIONS);

export const relayBoundarySchema = z.enum([
  "spec-to-plan",
  "plan-to-implementation",
  "implementation-to-audit",
]);

export const semanticDefinitionSchema = z.record(z.string(), z.unknown());

export const semanticContractSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  opaqueRef: z.string().min(1),
  canonicalDefinition: semanticDefinitionSchema,
  mutatedDefinition: semanticDefinitionSchema,
});

export const relayMutationSchema = z.object({
  boundary: relayBoundarySchema,
  fieldPath: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
});

export const relayScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    description: z.string().min(1),
    contract: semanticContractSchema,
    mutation: relayMutationSchema.nullable(),
    expectedAction: z.enum(["proceed", "halt"]),
  })
  .superRefine((scenario, context) => {
    if (scenario.mutation === null && scenario.expectedAction !== "proceed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A no-drift control must expect proceed.",
        path: ["expectedAction"],
      });
    }

    if (scenario.mutation !== null && scenario.expectedAction !== "halt") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A drift fixture must expect a fail-closed halt.",
        path: ["expectedAction"],
      });
    }
  });

export const relayScenarioSetSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  scenarios: z.array(relayScenarioSchema).min(1),
});

export const trialEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.enum([
    "message",
    "mutation",
    "hydration",
    "verification",
    "halt",
    "completion",
  ]),
  boundary: relayBoundarySchema.nullable(),
  agent: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
});

export const trialMetricsSchema = z.object({
  driftInjected: z.boolean(),
  driftDetected: z.boolean(),
  halted: z.boolean(),
  silentDivergence: z.boolean(),
  correctHalt: z.boolean(),
  falseHalt: z.boolean(),
  taskSuccess: z.boolean(),
  detectionBoundary: relayBoundarySchema.nullable(),
  wireBytes: z.number().int().nonnegative(),
  hydrationBytes: z.number().int().nonnegative(),
  totalSemanticBytes: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});

export const usageTelemetrySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokensRead: z.number().int().nonnegative(),
  cachedInputTokensWritten: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative(),
  attempts: z.number().int().min(1),
  retries: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  latencyMs: z.number().nonnegative(),
  stopReason: z.string().nullable(),
  costUsd: z.number().nonnegative().nullable(),
});

export const transcriptBlockSchema = z.object({
  type: z.string().min(1),
  text: z.string().nullable(),
  toolName: z.string().nullable(),
  toolInput: z.unknown(),
});

export const transcriptEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  role: z.enum(["system", "user", "assistant", "error"]),
  content: z.array(transcriptBlockSchema),
  raw: z.unknown(),
});

export const transcriptSchema = z.object({
  entries: z.array(transcriptEntrySchema),
});

export const trialProvenanceSchema = z.object({
  artifactSchemaVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  fixtureDigest: z.string().length(64),
  implementationCommit: z.string().min(1),
  dependencyLockDigest: z.string().length(64),
  promptDigest: z.string().length(64),
  semaVersion: z.string().min(1),
  canonicalizationVersion: z.string().min(1),
  vocabularyRoot: z.string(),
  semanticBackend: z.string().min(1),
  modelProvider: z.string().min(1),
  modelName: z.string().min(1),
});

export const trialRecordSchema = z.object({
  trialId: z.string().length(64),
  experimentId: z.string().min(1),
  scenarioId: z.string().min(1),
  condition: experimentConditionSchema,
  seed: z.number().int().nonnegative(),
  executionIndex: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  expectedAction: z.enum(["proceed", "halt"]),
  actualAction: z.enum(["proceed", "halt"]),
  events: z.array(trialEventSchema),
  metrics: trialMetricsSchema,
  provenance: trialProvenanceSchema,
  usage: usageTelemetrySchema.nullable(),
  transcript: transcriptSchema.nullable(),
});

export const resultManifestSchema = z.object({
  artifactSchemaVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  experimentId: z.string().min(1),
  runId: z.string().min(1),
  mode: z.enum(["deterministic-harness", "model-pilot", "confirmatory"]),
  evidenceClaim: z.string().min(1),
  createdAt: z.string().datetime(),
  orderSeed: z.number().int().nonnegative(),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  conditions: z.array(experimentConditionSchema).min(1),
  scenarioCount: z.number().int().positive(),
  trialCount: z.number().int().positive(),
  fixtureDigest: z.string().length(64),
  provenance: trialProvenanceSchema,
});

export type ExperimentCondition = z.infer<typeof experimentConditionSchema>;
export type RelayBoundary = z.infer<typeof relayBoundarySchema>;
export type RelayScenario = z.infer<typeof relayScenarioSchema>;
export type TrialEvent = z.infer<typeof trialEventSchema>;
export type TrialMetrics = z.infer<typeof trialMetricsSchema>;
export type UsageTelemetry = z.infer<typeof usageTelemetrySchema>;
export type TranscriptBlock = z.infer<typeof transcriptBlockSchema>;
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
export type TrialProvenance = z.infer<typeof trialProvenanceSchema>;
export type TrialRecord = z.infer<typeof trialRecordSchema>;
export type ResultManifest = z.infer<typeof resultManifestSchema>;
