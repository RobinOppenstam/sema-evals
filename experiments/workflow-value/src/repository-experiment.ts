import type { SemanticReferenceProvider } from "@sema-evals/adapters";
import { fingerprint, utf8Bytes } from "@sema-evals/core";
import {
  workflowRunnerResultSchema,
  type AgentWorkflowRunner,
  type RepositoryTaskSpec,
  type WritableHarnessAdapter,
} from "@sema-evals/workflow-runner";
import { z } from "zod";

import {
  loadFrozenWorkflowLibrary,
  renderEqualProseContent,
  renderResolvedReferenceContent,
  type FrozenWorkflowLibrary,
} from "./library.js";

export const REPOSITORY_WORKFLOW_CONDITIONS = [
  "task-only",
  "equal-library-prose",
  "opaque-resolver",
  "content-addressed",
  "content-addressed-notified-repair",
  "content-addressed-enforced",
] as const;

export const repositoryWorkflowConditionSchema = z.enum(
  REPOSITORY_WORKFLOW_CONDITIONS,
);

export type RepositoryWorkflowCondition = z.infer<
  typeof repositoryWorkflowConditionSchema
>;

export interface RepositoryWorkflowDelivery {
  prompt: string;
  wireBytes: number;
  hydrationBytes: number;
  contextPayloadBytes: number;
  contextPayloadTokens: number | null;
  resolvedContentDigest: string | null;
  reference: string | null;
  mismatchNotice: string | null;
  enforced: boolean;
  canonicalVerified: boolean;
  agentStartAllowed: boolean;
  stateTransitions: string[];
}

export async function buildRepositoryWorkflowDelivery(
  task: RepositoryTaskSpec,
  condition: RepositoryWorkflowCondition,
  library: FrozenWorkflowLibrary,
  referenceProvider: SemanticReferenceProvider,
  options: { forceResolutionFailure?: boolean } = {},
): Promise<RepositoryWorkflowDelivery> {
  const taskPayload = {
    taskId: task.taskId,
    request: task.taskRequest,
    visibleChecks: task.visibleChecks.map(({ argv }) => argv),
    allowedPaths: task.allowedPaths,
    prohibitedPaths: task.prohibitedPaths,
    resourceLimits: task.limits,
  };
  const resolvedContent = renderResolvedReferenceContent(library);
  const resolvedContentDigest = fingerprint(JSON.parse(resolvedContent));
  const staleContent = `${JSON.stringify(
    {
      ...JSON.parse(resolvedContent),
      version: `${library.library.version}-stale`,
    },
    null,
    2,
  )}\n`;
  const staleRoot = fingerprint(JSON.parse(staleContent));
  let wirePayload: Record<string, unknown> = { task: taskPayload };
  let visiblePayload: Record<string, unknown> = { task: taskPayload };
  let hydrationBytes = 0;
  let reference: string | null = null;
  let mismatchNotice: string | null = null;
  let enforced = false;
  let canonicalVerified =
    condition !== "content-addressed-notified-repair" &&
    condition !== "content-addressed-enforced";
  let agentStartAllowed = true;
  const stateTransitions: string[] = ["task-received"];
  let contextPayloadBytes = 0;

  if (condition === "equal-library-prose") {
    const prose = renderEqualProseContent(library);
    wirePayload = { task: taskPayload, workflowLibrary: prose };
    visiblePayload = wirePayload;
    contextPayloadBytes = utf8Bytes(prose);
  } else if (condition === "opaque-resolver") {
    reference = `workflow-library-${library.libraryRoot.slice(0, 16)}`;
    wirePayload = { task: taskPayload, workflowLibraryId: reference };
    visiblePayload = {
      ...wirePayload,
      resolvedWorkflowLibrary: resolvedContent,
    };
    hydrationBytes = utf8Bytes(resolvedContent);
    contextPayloadBytes = utf8Bytes(resolvedContent);
    stateTransitions.push("opaque-id-resolved");
  } else if (
    condition === "content-addressed" ||
    condition === "content-addressed-notified-repair" ||
    condition === "content-addressed-enforced"
  ) {
    const semanticReference = await referenceProvider.reference(
      "WorkflowLibrary",
      JSON.parse(resolvedContent),
    );
    reference = semanticReference.full;
    wirePayload = { task: taskPayload, workflowLibraryRef: reference };
    hydrationBytes = utf8Bytes(resolvedContent);
    contextPayloadBytes = utf8Bytes(resolvedContent);
    if (
      condition === "content-addressed-notified-repair" ||
      condition === "content-addressed-enforced"
    ) {
      mismatchNotice = [
        "semantic-reference-mismatch",
        `expected=${library.libraryRoot}`,
        `observed=${staleRoot}`,
        "Re-resolve the canonical workflow library before continuing.",
      ].join("; ");
      wirePayload = {
        ...wirePayload,
        localWorkflowLibraryRoot: staleRoot,
        mismatchNotice,
      };
      visiblePayload = {
        ...wirePayload,
        localWorkflowLibrary: staleContent,
      };
      stateTransitions.push("mismatch-detected", "repair-notified");
      if (!options.forceResolutionFailure) {
        visiblePayload = {
          ...visiblePayload,
          resolvedWorkflowLibrary: resolvedContent,
        };
        canonicalVerified = true;
        stateTransitions.push("canonical-resolved", "canonical-verified");
      } else {
        canonicalVerified = false;
        stateTransitions.push("canonical-resolution-failed");
      }
    } else {
      visiblePayload = {
        ...wirePayload,
        resolvedWorkflowLibrary: resolvedContent,
      };
      stateTransitions.push("content-reference-resolved");
    }
    if (condition === "content-addressed-enforced") {
      enforced = true;
      agentStartAllowed = canonicalVerified;
      stateTransitions.push(
        agentStartAllowed ? "enforcement-released" : "enforcement-blocked",
      );
    }
  }
  if (agentStartAllowed) {
    stateTransitions.push("agent-start-allowed");
  }

  return {
    prompt: JSON.stringify(visiblePayload, null, 2),
    wireBytes: utf8Bytes(wirePayload),
    hydrationBytes,
    contextPayloadBytes,
    contextPayloadTokens: null,
    resolvedContentDigest:
      condition === "task-only" ? null : resolvedContentDigest,
    reference,
    mismatchNotice,
    enforced,
    canonicalVerified,
    agentStartAllowed,
    stateTransitions,
  };
}

export const repositoryWorkflowTrialSchema = z
  .object({
    schemaVersion: z.literal("workflow-repository-trial-v1"),
    trialId: z.string().length(64),
    taskId: z.string().min(1),
    condition: repositoryWorkflowConditionSchema,
    primaryEndpoint: z.literal("final-hidden-validator-success-within-budget"),
    successWithinBudget: z.boolean(),
    executionStatus: z.enum(["runner-completed", "enforcement-blocked"]),
    delivery: z.object({
      wireBytes: z.number().int().nonnegative(),
      hydrationBytes: z.number().int().nonnegative(),
      contextPayloadBytes: z.number().int().nonnegative(),
      contextPayloadTokens: z.number().int().nonnegative().nullable(),
      resolvedContentDigest: z.string().length(64).nullable(),
      reference: z.string().nullable(),
      mismatchNotice: z.string().nullable(),
      enforced: z.boolean(),
      canonicalVerified: z.boolean(),
      agentStartAllowed: z.boolean(),
      stateTransitions: z.array(z.string().min(1)).min(1),
    }),
    modelTokens: z.object({
      input: z.number().int().nonnegative().nullable(),
      output: z.number().int().nonnegative().nullable(),
      cachedInputRead: z.number().int().nonnegative().nullable(),
      cachedInputWritten: z.number().int().nonnegative().nullable(),
      reasoning: z.number().int().nonnegative().nullable(),
      total: z.number().int().nonnegative().nullable(),
    }),
    runnerResult: workflowRunnerResultSchema.nullable(),
    fingerprints: z.object({
      protocol: z.string().length(64),
      prompt: z.string().length(64),
      dataset: z.string().length(64),
      modelImplementation: z.string().length(64),
      scorer: z.string().length(64),
      libraryRoot: z.string().length(64),
      mapping: z.string().length(64),
      leakageAudit: z.string().length(64),
      sources: z.string().length(64),
      semaVersion: z.string().min(1),
      canonicalizationVersion: z.string().min(1),
      vocabularyRoot: z.string(),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.executionStatus === "enforcement-blocked" &&
      (value.runnerResult !== null || value.delivery.agentStartAllowed)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enforcement-blocked trials may not start the runner.",
      });
    }
  });

export type RepositoryWorkflowTrial = z.infer<
  typeof repositoryWorkflowTrialSchema
>;

export async function runRepositoryWorkflowTrial(params: {
  task: RepositoryTaskSpec;
  condition: RepositoryWorkflowCondition;
  harness: WritableHarnessAdapter;
  runner: AgentWorkflowRunner;
  referenceProvider: SemanticReferenceProvider;
  datasetDigest: string;
  scorerFingerprint: string;
  vocabularyRoot: string;
  forceResolutionFailure?: boolean;
}): Promise<RepositoryWorkflowTrial> {
  const library = await loadFrozenWorkflowLibrary();
  const delivery = await buildRepositoryWorkflowDelivery(
    params.task,
    params.condition,
    library,
    params.referenceProvider,
    {
      ...(params.forceResolutionFailure === undefined
        ? {}
        : { forceResolutionFailure: params.forceResolutionFailure }),
    },
  );
  const semanticMetadata = await params.referenceProvider.metadata();
  const runnerResult = delivery.agentStartAllowed
    ? await params.runner.run({
        task: params.task,
        prompt: delivery.prompt,
        harness: params.harness,
      })
    : null;
  const usage = runnerResult?.usage ?? null;
  const total = usage === null ? null : usage.inputTokens + usage.outputTokens;
  const protocol = fingerprint({
    version: "workflow-repository-value-v1",
    conditions: REPOSITORY_WORKFLOW_CONDITIONS,
    primaryEndpoint: "final-hidden-validator-success-within-budget",
    checkpointEndpoint: "tokens-to-first-passing-checkpoint",
    libraryRoot: library.libraryRoot,
    mappingDigest: library.mappingDigest,
    harness: runnerResult?.harness ?? params.harness.descriptor,
    taskLimits: params.task.limits,
  });
  return repositoryWorkflowTrialSchema.parse({
    schemaVersion: "workflow-repository-trial-v1",
    trialId: fingerprint({
      runnerTrialId: runnerResult?.trialId ?? null,
      condition: params.condition,
      protocol,
    }),
    taskId: params.task.taskId,
    condition: params.condition,
    primaryEndpoint: "final-hidden-validator-success-within-budget",
    successWithinBudget: runnerResult?.status === "passed",
    executionStatus:
      runnerResult === null ? "enforcement-blocked" : "runner-completed",
    delivery: {
      wireBytes: delivery.wireBytes,
      hydrationBytes: delivery.hydrationBytes,
      contextPayloadBytes: delivery.contextPayloadBytes,
      contextPayloadTokens: delivery.contextPayloadTokens,
      resolvedContentDigest: delivery.resolvedContentDigest,
      reference: delivery.reference,
      mismatchNotice: delivery.mismatchNotice,
      enforced: delivery.enforced,
      canonicalVerified: delivery.canonicalVerified,
      agentStartAllowed: delivery.agentStartAllowed,
      stateTransitions: delivery.stateTransitions,
    },
    modelTokens: {
      input: usage?.inputTokens ?? null,
      output: usage?.outputTokens ?? null,
      cachedInputRead: usage?.cachedInputTokensRead ?? null,
      cachedInputWritten: usage?.cachedInputTokensWritten ?? null,
      reasoning: usage?.reasoningTokens ?? null,
      total,
    },
    runnerResult,
    fingerprints: {
      protocol,
      prompt: fingerprint(delivery.prompt),
      dataset: params.datasetDigest,
      modelImplementation: fingerprint(
        runnerResult?.harness ?? params.harness.descriptor,
      ),
      scorer: params.scorerFingerprint,
      libraryRoot: library.libraryRoot,
      mapping: library.mappingDigest,
      leakageAudit: library.leakageAuditDigest,
      sources: library.sourcesDigest,
      semaVersion: semanticMetadata.semaVersion,
      canonicalizationVersion: semanticMetadata.canonicalizationVersion,
      vocabularyRoot: params.vocabularyRoot,
    },
  });
}
