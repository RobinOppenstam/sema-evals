import { trialEventSchema, trialProvenanceSchema } from "@sema-evals/core";
import { z } from "zod";

export const SEMA_DISCOVERY_PROTOCOL_VERSION = "sema-discovery-v1";
export const SEMA_DISCOVERY_SCORER_VERSION = "sema-discovery-scorer-v1";

export const SEMA_DISCOVERY_CONDITIONS = [
  "task-only",
  "preselected-prose",
  "preselected-addressed",
  "discovery",
  "discovery-reuse",
] as const;

export const semaDiscoveryConditionSchema = z.enum(SEMA_DISCOVERY_CONDITIONS);

export const discoveryPatternSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  title: z.string().min(1),
  purpose: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  dependencies: z.array(z.string().regex(/^[A-Z][A-Za-z0-9]*$/)),
  steps: z.array(z.string().min(1)).min(1),
});

export const discoveryTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  request: z.string().min(1),
  expectedActions: z.array(z.string().min(1)).min(1),
});

export const discoveryScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  correctHandle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  tasks: z.array(discoveryTaskSchema).length(2),
});

export const discoveryFixtureSetSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  catalog: z.array(discoveryPatternSchema).min(4),
  scenarios: z.array(discoveryScenarioSchema).min(1),
});

export const searchParametersSchema = z.object({
  version: z.literal("lexical-search-v1"),
  minimumScore: z.literal(1),
  maxResults: z.literal(3),
  queryFields: z.tuple([z.literal("task-request")]),
  patternFields: z.tuple([
    z.literal("handle"),
    z.literal("title"),
    z.literal("purpose"),
    z.literal("tags"),
  ]),
  ordering: z.literal("score-desc-handle-asc"),
});

export const discoveryTaskResultSchema = z.object({
  taskId: z.string().min(1),
  searchPerformed: z.boolean(),
  candidates: z.array(
    z.object({
      handle: z.string().min(1),
      score: z.number().int().positive(),
    }),
  ),
  selectedHandle: z.string().nullable(),
  selectedRank: z.number().int().positive().nullable(),
  correctSelection: z.boolean(),
  dependencyStatus: z.enum(["complete", "missing", "cycle", "not-provided"]),
  resolvedHandles: z.array(z.string()),
  missingHandles: z.array(z.string()),
  executionPassed: z.boolean(),
  reuseHit: z.boolean(),
  outputActions: z.array(z.string()),
});

export const semaDiscoveryMetricsSchema = z.object({
  sessionResetAtStart: z.literal(true),
  sessionClearedAtEnd: z.literal(true),
  searchesPerformed: z.number().int().nonnegative(),
  candidatesReturned: z.number().int().nonnegative(),
  distractorsConsidered: z.number().int().nonnegative(),
  selectionsPerformed: z.number().int().nonnegative(),
  correctSelections: z.number().int().nonnegative(),
  requiredDependencyCount: z.number().int().nonnegative(),
  resolvedDependencyCount: z.number().int().nonnegative(),
  missingDependencyCount: z.number().int().nonnegative(),
  dependencyComplete: z.boolean(),
  executionsPassed: z.number().int().nonnegative(),
  reuseHits: z.number().int().nonnegative(),
  searchesAvoided: z.number().int().nonnegative(),
  dependencyResolutionsAvoided: z.number().int().nonnegative(),
  endToEndDiscoverySuccess: z.boolean(),
  wireBytes: z.number().int().nonnegative(),
  hydrationBytes: z.number().int().nonnegative(),
  totalSemanticBytes: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});

export const semaDiscoveryTrialRecordSchema = z.object({
  trialId: z.string().length(64),
  experimentId: z.literal("sema-discovery"),
  scenarioId: z.string().min(1),
  condition: semaDiscoveryConditionSchema,
  seed: z.number().int().nonnegative(),
  executionIndex: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  taskResults: z.array(discoveryTaskResultSchema).length(2),
  events: z.array(trialEventSchema),
  metrics: semaDiscoveryMetricsSchema,
  provenance: trialProvenanceSchema,
  usage: z.null(),
  transcript: z.null(),
});

export const semaDiscoveryManifestSchema = z.object({
  artifactSchemaVersion: z.string().min(1),
  protocolVersion: z.literal(SEMA_DISCOVERY_PROTOCOL_VERSION),
  experimentId: z.literal("sema-discovery"),
  runId: z.string().min(1),
  mode: z.literal("deterministic-harness"),
  evidenceClaim: z.string().min(1),
  createdAt: z.string().datetime(),
  orderSeed: z.number().int().nonnegative(),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  conditions: z.array(semaDiscoveryConditionSchema).length(5),
  scenarioCount: z.number().int().positive(),
  trialCount: z.number().int().positive(),
  fixtureDigest: z.string().length(64),
  catalogFingerprint: z.string().length(64),
  rankerFingerprint: z.string().length(64),
  searchParameters: searchParametersSchema,
  scorer: z.object({
    version: z.literal(SEMA_DISCOVERY_SCORER_VERSION),
    fingerprint: z.string().length(64),
  }),
  protocolFingerprint: z.string().length(64),
  runConfiguration: z.object({
    mode: z.literal("deterministic-harness"),
    orderSeed: z.number().int().nonnegative(),
    repetitionCount: z.number().int().positive(),
    semanticBackend: z.string().min(1),
    sessionReset: z.literal("before-every-trial"),
    discoveryReuseScope: z.literal("within-trial-only"),
  }),
  provenance: trialProvenanceSchema,
});

export type DiscoveryPattern = z.infer<typeof discoveryPatternSchema>;
export type DiscoveryScenario = z.infer<typeof discoveryScenarioSchema>;
export type DiscoveryFixtureSet = z.infer<typeof discoveryFixtureSetSchema>;
export type SemaDiscoveryCondition = z.infer<
  typeof semaDiscoveryConditionSchema
>;
export type DiscoveryTaskResult = z.infer<typeof discoveryTaskResultSchema>;
export type SemaDiscoveryTrialRecord = z.infer<
  typeof semaDiscoveryTrialRecordSchema
>;
export type SemaDiscoveryManifest = z.infer<typeof semaDiscoveryManifestSchema>;
