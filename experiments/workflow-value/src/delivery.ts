import type { SemanticReferenceProvider } from "@sema-evals/adapters";
import { fingerprint, utf8Bytes } from "@sema-evals/core";

import { conditionPolicy } from "./conditions.js";
import type { WorkflowTask, WorkflowValueCondition } from "./schemas.js";

export interface WorkflowDelivery {
  userMessage: string;
  wireBytes: number;
  hydrationBytes: number;
  workflowReference: {
    handle: string;
    ref: string;
    digest: string;
    backend: string;
  } | null;
  opaqueReference: string | null;
  mismatchNotice: string | null;
}

function baseTask(task: WorkflowTask): Record<string, unknown> {
  return {
    request: task.request,
    localDraft: task.localDraft,
    outputContract: {
      format: "JSON object only",
      fields: [
        "workflowId",
        "orderedActions",
        "requiredArtifacts",
        "escalationTarget",
        "completionState",
      ],
    },
  };
}

export async function buildWorkflowDelivery(
  task: WorkflowTask,
  condition: WorkflowValueCondition,
  referenceProvider: SemanticReferenceProvider,
): Promise<WorkflowDelivery> {
  const policy = conditionPolicy(condition);
  const taskPayload = baseTask(task);
  const definition = task.workflow.output;
  const workflowLibrary = {
    handle: task.workflow.handle,
    title: task.workflow.title,
    purpose: task.workflow.purpose,
    output: definition,
  };
  const definitionBytes = utf8Bytes(workflowLibrary);
  let wirePayload: Record<string, unknown> = { task: taskPayload };
  let hydrationBytes = 0;
  let workflowReference: WorkflowDelivery["workflowReference"] = null;
  let opaqueReference: string | null = null;
  let mismatchNotice: string | null = null;

  if (policy.wireStyle === "inline-prose") {
    wirePayload = { task: taskPayload, resolvedWorkflow: workflowLibrary };
  } else if (policy.wireStyle === "opaque-reference") {
    opaqueReference = `workflow-${fingerprint({
      taskId: task.id,
      handle: task.workflow.handle,
    }).slice(0, 16)}`;
    wirePayload = { task: taskPayload, workflowId: opaqueReference };
    hydrationBytes = definitionBytes;
  } else if (policy.wireStyle === "content-reference") {
    const reference = await referenceProvider.reference(
      task.workflow.handle,
      workflowLibrary,
    );
    workflowReference = {
      handle: reference.handle,
      ref: reference.full,
      digest: reference.digest,
      backend: reference.backend,
    };
    wirePayload = { task: taskPayload, workflowRef: reference.full };
    hydrationBytes = definitionBytes;
  }

  if (policy.explicitMismatchNotice) {
    mismatchNotice = task.mismatch.notice;
    wirePayload = { ...wirePayload, mismatchNotice };
  }

  const visiblePayload: Record<string, unknown> = {
    ...wirePayload,
    ...(policy.deliversWorkflow && policy.wireStyle !== "inline-prose"
      ? {
          resolvedWorkflow: workflowLibrary,
        }
      : {}),
    ...(mismatchNotice === null
      ? {}
      : {
          repairInstruction:
            "Repair the local draft against the resolved workflow before returning the final object.",
        }),
  };

  return {
    userMessage: JSON.stringify(visiblePayload, null, 2),
    wireBytes: utf8Bytes(wirePayload),
    hydrationBytes,
    workflowReference,
    opaqueReference,
    mismatchNotice,
  };
}
