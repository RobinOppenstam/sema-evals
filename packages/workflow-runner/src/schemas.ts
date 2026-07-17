import { transcriptSchema, usageTelemetrySchema } from "@sema-evals/core";
import { z } from "zod";

export const workflowCommandSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).default("."),
  env: z.record(z.string()).default({}),
  timeoutMs: z.number().int().positive(),
});

export const workflowResourceLimitsSchema = z.object({
  wallClockMs: z.number().int().positive(),
  commandTimeoutMs: z.number().int().positive(),
  memoryBytes: z.number().int().positive(),
  diskBytes: z.number().int().positive(),
  pids: z.number().int().positive(),
  cpus: z.number().positive(),
  maxCommands: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
});

export const workflowTaskProvenanceSchema = z.object({
  sourceRepository: z.string().min(1),
  sourceCommit: z.string().min(1),
  licenseSpdx: z.string().min(1),
  acquisitionDigest: z.string().length(64),
  validatorDigest: z.string().length(64),
  familyId: z.string().min(1),
  split: z.enum(["train", "dev", "heldout"]),
});

export const repositoryTaskSpecSchema = z.object({
  schemaVersion: z.literal("workflow-repository-task-v1"),
  taskId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  snapshotDirectory: z.string().min(1),
  snapshotDigest: z.string().length(64),
  taskRequest: z.string().min(1),
  setupCommand: workflowCommandSchema.nullable(),
  visibleChecks: z.array(workflowCommandSchema).min(1),
  hiddenValidator: workflowCommandSchema,
  hiddenValidatorSourcePath: z.string().min(1),
  hiddenValidatorSourceDigest: z.string().length(64),
  offlineDependencyCache: z
    .object({
      directory: z.string().min(1),
      digest: z.string().length(64),
      mountPath: z.literal("/workflow-cache"),
      setupWritablePaths: z.array(z.string().min(1)),
    })
    .nullable(),
  allowedPaths: z.array(z.string().min(1)).min(1),
  prohibitedPaths: z.array(z.string().min(1)),
  limits: workflowResourceLimitsSchema,
  provenance: workflowTaskProvenanceSchema,
});

export const harnessProviderSchema = z.enum([
  "claude-code",
  "codex-cli",
  "grok-build",
  "cursor-agent",
  "opencode",
  "deterministic-fake",
]);

export const budgetChannelSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("streaming-tokens"),
    maxTotalTokens: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("turn-wall-clock-proxy"),
    maxTurns: z.number().int().positive(),
    maxWallClockMs: z.number().int().positive(),
  }),
]);

export const writableHarnessDescriptorSchema = z
  .object({
    provider: harnessProviderSchema,
    binary: z.string().min(1),
    binaryVersion: z.string().min(1),
    modelSelector: z.string().min(1),
    runnerImage: z.string().min(1),
    runnerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    autoUpdateDisabled: z.boolean(),
    isolatedHome: z.boolean(),
    userInstructionsDisabled: z.boolean(),
    globalConfigDisabled: z.boolean(),
    mcpDisabled: z.boolean(),
    webToolsDisabled: z.boolean(),
    conformanceStatus: z.enum(["unverified", "verified"]),
    verificationDigest: z.string().length(64).nullable(),
    blockReasons: z.array(z.string().min(1)),
    usageTelemetry: z.enum(["available", "unavailable"]),
    checkpointChannel: z.enum(["stream-events", "terminal-only"]),
    authInjection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      z.object({
        kind: z.literal("read-only-secret"),
        secretSurfaceDigest: z.string().length(64),
      }),
    ]),
    budgetChannel: budgetChannelSchema,
    providerEndpoints: z.array(z.string().min(1)),
  })
  .superRefine((value, context) => {
    if (
      value.conformanceStatus === "verified" &&
      (!value.autoUpdateDisabled ||
        !value.isolatedHome ||
        !value.userInstructionsDisabled ||
        !value.globalConfigDisabled ||
        !value.mcpDisabled ||
        !value.webToolsDisabled ||
        value.verificationDigest === null ||
        value.blockReasons.length > 0 ||
        value.checkpointChannel !== "stream-events")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Verified harness descriptor is missing enforced controls.",
      });
    }
  });

export const sandboxControlSchema = z.object({
  implementation: z.literal("docker-oci-v1"),
  dockerVersion: z.string().min(1),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  networkMode: z.enum(["none", "allowlist-proxy"]),
  proxyPolicyDigest: z.string().length(64).nullable(),
  nonRootUid: z.number().int().positive(),
  readOnlyRoot: z.literal(true),
  noNewPrivileges: z.literal(true),
  capabilitiesDropped: z.literal(true),
  capabilityAllowlist: z
    .array(
      z.enum(["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"]),
    )
    .length(6),
  seccompProfileDigest: z.string().min(1),
  auditedStatePaths: z.tuple([z.literal("/home/agent"), z.literal("/tmp")]),
  workspaceTmpfsBytes: z.number().int().positive(),
  memoryBytes: z.number().int().positive(),
  pids: z.number().int().positive(),
  cpus: z.number().positive(),
  processTraceVerified: z.literal(true),
});

export const commandEvidenceSchema = z.object({
  sequence: z.number().int().nonnegative(),
  phase: z.enum(["setup", "harness", "visible-validator", "hidden-validator"]),
  argv: z.array(z.string()),
  cwd: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  outputOverflow: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutDigest: z.string().length(64),
  stderrDigest: z.string().length(64),
  processTraceDigest: z.string().length(64),
});

export const checkpointEvidenceSchema = z.object({
  checkpointId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  treeDigest: z.string().length(64),
  createdAt: z.string().datetime(),
  hiddenValidatorPassed: z.boolean(),
  hiddenValidatorExitCode: z.number().int().nullable(),
  cumulativeModelTokens: z.number().int().nonnegative().nullable(),
  harnessStateDigests: z.object({
    home: z.string().length(64),
    tmp: z.string().length(64),
  }),
  harnessStateChanges: z.object({
    home: z.array(z.string()),
    tmp: z.array(z.string()),
  }),
});

export const workflowRunnerStatusSchema = z.enum([
  "passed",
  "validator-failed",
  "harness-failed",
  "setup-failed",
  "timeout",
  "resource-violation",
  "policy-violation",
  "control-unavailable",
]);

export const workflowRunnerResultSchema = z.object({
  protocolVersion: z.literal("agent-workflow-runner-v1"),
  trialId: z.string().length(64),
  taskId: z.string().min(1),
  status: workflowRunnerStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  initialTreeDigest: z.string().length(64),
  finalTreeDigest: z.string().length(64),
  changedPaths: z.array(z.string()),
  unauthorizedChangedPaths: z.array(z.string()),
  commandLog: z.array(commandEvidenceSchema),
  checkpoints: z.array(checkpointEvidenceSchema),
  visibleValidatorPassed: z.boolean(),
  hiddenValidatorPassed: z.boolean(),
  tokensToFirstPassingCheckpoint: z.number().int().nonnegative().nullable(),
  transcript: transcriptSchema,
  usage: usageTelemetrySchema.nullable(),
  finalPatch: z.string(),
  finalPatchDigest: z.string().length(64),
  sandbox: sandboxControlSchema.nullable(),
  harness: writableHarnessDescriptorSchema,
  failure: z
    .object({
      stage: z.string().min(1),
      message: z.string().min(1),
    })
    .nullable(),
  preservationErrors: z.array(z.string()),
  retainedWorkspace: z.string().nullable(),
});

export type WorkflowCommand = z.infer<typeof workflowCommandSchema>;
export type WorkflowResourceLimits = z.infer<
  typeof workflowResourceLimitsSchema
>;
export type RepositoryTaskSpec = z.infer<typeof repositoryTaskSpecSchema>;
export type BudgetChannel = z.infer<typeof budgetChannelSchema>;
export type WritableHarnessDescriptor = z.infer<
  typeof writableHarnessDescriptorSchema
>;
export type SandboxControl = z.infer<typeof sandboxControlSchema>;
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;
export type CheckpointEvidence = z.infer<typeof checkpointEvidenceSchema>;
export type WorkflowRunnerStatus = z.infer<typeof workflowRunnerStatusSchema>;
export type WorkflowRunnerResult = z.infer<typeof workflowRunnerResultSchema>;
