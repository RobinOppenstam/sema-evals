import {
  trialEventSchema,
  trialProvenanceSchema,
  transcriptSchema,
  usageTelemetrySchema,
} from "@sema-evals/core";
import { z } from "zod";

export const WORKFLOW_TOTAL_TOKEN_BUDGET = 2048;
export const WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE = 512;
export const WORKFLOW_VALUE_PROTOCOL_VERSION = "workflow-value-v1";

export const WORKFLOW_VALUE_CONDITIONS = [
  "task-only",
  "equal-prose",
  "opaque-resolver",
  "content-addressed",
  "content-addressed-repair",
] as const;

export const workflowValueConditionSchema = z.enum(WORKFLOW_VALUE_CONDITIONS);
export const workflowSplitSchema = z.enum(["dev", "eval"]);
export const workflowDatasetStatusSchema = z.enum(["seed-only", "acquired"]);

export const workflowOutputSchema = z.object({
  workflowId: z.string().min(1),
  orderedActions: z.array(z.string().min(1)).min(1),
  requiredArtifacts: z.array(z.string().min(1)).min(1),
  escalationTarget: z.string().min(1),
  completionState: z.string().min(1),
});

export const workflowDefinitionSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  title: z.string().min(1),
  purpose: z.string().min(1),
  output: workflowOutputSchema,
});

export const workflowMismatchSchema = z.object({
  fieldPath: z.string().min(1),
  notice: z.string().min(1),
});

export const workflowTaskContractSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("structured-json"),
  }),
  z.object({
    kind: z.literal("repository-workspace"),
    repositoryFixture: z.string().min(1),
    setupCommand: z.array(z.string().min(1)).min(1),
    validatorCommand: z.array(z.string().min(1)).min(1),
    allowedPaths: z.array(z.string().min(1)).min(1),
  }),
]);

export const hiddenValidatorSchema = z.object({
  version: z.literal("workflow-exact-validator-v1"),
  expected: workflowOutputSchema,
});

export const workflowTaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    split: workflowSplitSchema,
    contract: workflowTaskContractSchema,
    title: z.string().min(1),
    request: z.string().min(1),
    workflow: workflowDefinitionSchema,
    localDraft: workflowOutputSchema,
    mismatch: workflowMismatchSchema,
    validator: hiddenValidatorSchema,
  })
  .superRefine((task, context) => {
    if (
      task.validator.expected.workflowId !== task.workflow.output.workflowId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Hidden validator must target the delivered workflow.",
        path: ["validator", "expected", "workflowId"],
      });
    }
    if (
      JSON.stringify(task.validator.expected) !==
      JSON.stringify(task.workflow.output)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Hidden validator expected output must equal the workflow definition output.",
        path: ["validator", "expected"],
      });
    }
    if (
      JSON.stringify(task.localDraft) ===
      JSON.stringify(task.validator.expected)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Seed task localDraft must contain a repairable mismatch.",
        path: ["localDraft"],
      });
    }
  });

export const workflowDatasetSchema = z.discriminatedUnion("status", [
  z.object({
    label: z.string().min(1),
    status: z.literal("seed-only"),
    source: z.string().min(1),
    acquisitionRequirement: z.string().min(1),
  }),
  z.object({
    label: z.string().min(1),
    status: z.literal("acquired"),
    source: z.string().min(1),
    acquisitionRequirement: z.string().min(1),
    license: z.string().min(1),
    acquiredAt: z.string().datetime(),
    corpusDigest: z.string().length(64),
    taskFamilySplitMethod: z.string().min(1),
    deduplicationReport: z.string().min(1),
    leakageReview: z.string().min(1),
    validatorReview: z.string().min(1),
  }),
]);

export const workflowFixtureSetSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  dataset: workflowDatasetSchema,
  tasks: z.array(workflowTaskSchema).min(2),
});

export const workflowModelCompletionStatusSchema = z.enum([
  "completed",
  "refused",
  "truncated",
  "error",
]);

export const workflowValueMetricsSchema = z.object({
  split: workflowSplitSchema,
  parseFailure: z.boolean(),
  validationPassed: z.boolean(),
  /** Primary endpoint: executable validator passes without exceeding budget. */
  successWithinBudget: z.boolean(),
  withinTokenBudget: z.boolean(),
  tokenBudget: z.literal(WORKFLOW_TOTAL_TOKEN_BUDGET),
  invocationTokenReserve: z.literal(WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE),
  matchedConstraints: z.number().int().nonnegative(),
  totalConstraints: z.number().int().positive(),
  repairNoticeProvided: z.boolean(),
  repairApplied: z.boolean(),
  wireBytes: z.number().int().nonnegative(),
  hydrationBytes: z.number().int().nonnegative(),
  totalSemanticBytes: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokensRead: z.number().int().nonnegative(),
  cachedInputTokensWritten: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative(),
  totalModelTokens: z.number().int().nonnegative(),
  tokensToFirstPassingSolution: z.number().int().nonnegative().nullable(),
  editTestCycles: z.number().int().positive(),
  failedEditTestCycles: z.number().int().nonnegative(),
  regressions: z.number().int().nonnegative(),
  reworkCycles: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  providerErrors: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  modelLatencyMs: z.number().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});

export const workflowReferenceSchema = z.object({
  handle: z.string().min(1),
  ref: z.string().min(1),
  digest: z.string().length(64),
  backend: z.string().min(1),
});

export const workflowValueTrialRecordSchema = z.object({
  trialId: z.string().length(64),
  experimentId: z.string().min(1),
  scenarioId: z.string().min(1),
  taskId: z.string().min(1),
  datasetLabel: z.string().min(1),
  split: workflowSplitSchema,
  condition: workflowValueConditionSchema,
  seed: z.number().int().nonnegative(),
  executionIndex: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  workflowReference: workflowReferenceSchema.nullable(),
  opaqueReference: z.string().nullable(),
  mismatchNotice: z.string().nullable(),
  rawOutput: z.string(),
  parsedOutput: workflowOutputSchema.nullable(),
  modelCompletionStatus: workflowModelCompletionStatusSchema.nullable(),
  events: z.array(trialEventSchema),
  metrics: workflowValueMetricsSchema,
  provenance: trialProvenanceSchema,
  usage: usageTelemetrySchema.nullable(),
  transcript: transcriptSchema.nullable(),
});

export const workflowDatasetGateSchema = z.discriminatedUnion("status", [
  z.object({
    datasetLabel: z.string().min(1),
    status: z.literal("seed-only"),
    readyForModelPilot: z.literal(false),
    requirement: z.string().min(1),
  }),
  z.object({
    datasetLabel: z.string().min(1),
    status: z.literal("acquired"),
    readyForModelPilot: z.literal(true),
    requirement: z.string().min(1),
    license: z.string().min(1),
    acquiredAt: z.string().datetime(),
    corpusDigest: z.string().length(64),
    taskFamilySplitMethod: z.string().min(1),
    deduplicationReport: z.string().min(1),
    leakageReview: z.string().min(1),
    validatorReview: z.string().min(1),
  }),
]);

export const workflowValueResultManifestSchema = z.object({
  artifactSchemaVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  experimentId: z.literal("workflow-value"),
  runId: z.string().min(1),
  mode: z.literal("deterministic-harness"),
  evidenceClaim: z.string().min(1),
  createdAt: z.string().datetime(),
  orderSeed: z.number().int().nonnegative(),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  conditions: z.array(workflowValueConditionSchema).length(5),
  devTaskCount: z.number().int().positive(),
  evalTaskCount: z.number().int().positive(),
  trialCount: z.number().int().positive(),
  tokenBudget: z.literal(WORKFLOW_TOTAL_TOKEN_BUDGET),
  invocationTokenReserve: z.literal(WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE),
  fixtureDigest: z.string().length(64),
  datasetGate: workflowDatasetGateSchema,
  scorer: z.object({
    version: z.string().min(1),
    fingerprint: z.string().length(64),
  }),
  protocolFingerprint: z.string().length(64),
  runConfiguration: z.object({
    mode: z.literal("deterministic-harness"),
    seeds: z.array(z.number().int().nonnegative()).min(1),
    orderSeed: z.number().int().nonnegative(),
    tokenBudget: z.literal(WORKFLOW_TOTAL_TOKEN_BUDGET),
    invocationTokenReserve: z.literal(WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE),
    semanticBackend: z.string().min(1),
    policy: z.string().min(1),
  }),
  provenance: trialProvenanceSchema,
});

export type WorkflowValueCondition = z.infer<
  typeof workflowValueConditionSchema
>;
export type WorkflowSplit = z.infer<typeof workflowSplitSchema>;
export type WorkflowDatasetStatus = z.infer<typeof workflowDatasetStatusSchema>;
export type WorkflowOutput = z.infer<typeof workflowOutputSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowTask = z.infer<typeof workflowTaskSchema>;
export type WorkflowTaskContract = z.infer<typeof workflowTaskContractSchema>;
export type WorkflowFixtureSet = z.infer<typeof workflowFixtureSetSchema>;
export type WorkflowValueMetrics = z.infer<typeof workflowValueMetricsSchema>;
export type WorkflowValueTrialRecord = z.infer<
  typeof workflowValueTrialRecordSchema
>;
export type WorkflowValueResultManifest = z.infer<
  typeof workflowValueResultManifestSchema
>;
export type WorkflowDatasetGate = z.infer<typeof workflowDatasetGateSchema>;
