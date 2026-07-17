import {
  createModelProvider,
  type ModelAgentAdapter,
  type ModelCompletion,
  type ModelPromptInput,
  type ModelProviderConfig,
} from "@sema-evals/adapters";
import {
  fingerprint,
  transcriptSchema,
  usageTelemetrySchema,
} from "@sema-evals/core";
import type { RepositoryTaskSpec } from "@sema-evals/workflow-runner";
import { z } from "zod";

export const securityModelReadinessGateSchema = z
  .object({
    schemaVersion: z.literal("security-model-readiness-v1"),
    ready: z.boolean(),
    corpusReady: z.boolean(),
    modelConfigured: z.boolean(),
    writableHarnessVerified: z.boolean(),
    repositoryExecutorWired: z.boolean(),
    blockReasons: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((gate, context) => {
    const expected = [
      ...(gate.corpusReady ? [] : ["held-out-security-corpus-not-acquired"]),
      ...(gate.modelConfigured ? [] : ["model-provider-not-configured"]),
      ...(gate.writableHarnessVerified
        ? []
        : ["security-writable-harness-not-verified"]),
      ...(gate.repositoryExecutorWired
        ? []
        : ["security-repository-executor-not-wired"]),
    ];
    if (
      gate.ready !== (expected.length === 0) ||
      JSON.stringify(gate.blockReasons) !== JSON.stringify(expected)
    ) {
      context.addIssue({
        code: "custom",
        path: ["blockReasons"],
        message: "readiness prerequisites are inconsistent",
      });
    }
  });

export const securityModelExecutorResultSchema = z.object({
  schemaVersion: z.literal("security-model-executor-v1"),
  status: z.enum(["completed", "refused", "truncated", "error", "blocked"]),
  requestFingerprint: z.string().length(64),
  executorFingerprint: z.string().length(64),
  rawOutput: z.string(),
  transcript: transcriptSchema.nullable(),
  usage: usageTelemetrySchema.nullable(),
  failure: z.object({ stage: z.string(), message: z.string() }).nullable(),
});

export type SecurityModelReadinessGate = z.infer<
  typeof securityModelReadinessGateSchema
>;

export interface SecurityAuditorRequest {
  task: RepositoryTaskSpec;
  auditPrompt: string;
}

export function createSecurityModelProvider(config: ModelProviderConfig) {
  return createModelProvider(config);
}

export async function executeSecurityAuditor(
  adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion>,
  gateInput: SecurityModelReadinessGate,
  request: SecurityAuditorRequest,
) {
  const gate = securityModelReadinessGateSchema.parse(gateInput);
  const requestFingerprint = fingerprint({
    taskId: request.task.taskId,
    snapshotDigest: request.task.snapshotDigest,
    provenance: request.task.provenance,
    auditPrompt: request.auditPrompt,
  });
  const executorFingerprint = fingerprint({
    version: "security-model-executor-v1",
    adapter: adapter.descriptor,
    writableContract: "agent-workflow-runner-v1",
  });
  return securityModelExecutorResultSchema.parse({
    schemaVersion: "security-model-executor-v1",
    status: "blocked",
    requestFingerprint,
    executorFingerprint,
    rawOutput: "",
    transcript: null,
    usage: null,
    failure: {
      stage: "readiness",
      message:
        gate.blockReasons.join("; ") ||
        "security-repository-executor-not-wired",
    },
  });
}
