import { fingerprint } from "@sema-evals/core";

import {
  workflowOutputSchema,
  type WorkflowOutput,
  type WorkflowTask,
} from "./schemas.js";

export const WORKFLOW_VALUE_SCORER_VERSION = "workflow-exact-validator-v1";
export const WORKFLOW_VALUE_SCORER_FINGERPRINT = fingerprint({
  version: WORKFLOW_VALUE_SCORER_VERSION,
  parser: "plain-or-single-json-code-fence",
  validation:
    "exact-workflow-id-actions-artifacts-escalation-target-completion-state",
  primary: "validation-passed-and-input-plus-output-tokens-within-2048",
  parseFailure: "preserve-output-and-score-failure",
});

export interface ParsedWorkflowOutput {
  parseable: boolean;
  output: WorkflowOutput | null;
  error: string | null;
}

export interface WorkflowValidationScore {
  scorerVersion: string;
  validationPassed: boolean;
  matchedConstraints: number;
  totalConstraints: number;
  checks: Readonly<Record<string, boolean>>;
}

function stripSingleJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export function parseWorkflowOutput(text: string): ParsedWorkflowOutput {
  let value: unknown;
  try {
    value = JSON.parse(stripSingleJsonFence(text));
  } catch (error) {
    return {
      parseable: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const parsed = workflowOutputSchema.safeParse(value);
  if (!parsed.success) {
    return {
      parseable: false,
      output: null,
      error: parsed.error.message,
    };
  }
  return { parseable: true, output: parsed.data, error: null };
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function validateWorkflowOutput(
  task: WorkflowTask,
  output: WorkflowOutput | null,
): WorkflowValidationScore {
  const expected = task.validator.expected;
  const checks = {
    workflowId: output?.workflowId === expected.workflowId,
    orderedActions:
      output !== null &&
      sameStrings(output.orderedActions, expected.orderedActions),
    requiredArtifacts:
      output !== null &&
      sameStrings(output.requiredArtifacts, expected.requiredArtifacts),
    escalationTarget: output?.escalationTarget === expected.escalationTarget,
    completionState: output?.completionState === expected.completionState,
  };
  const matchedConstraints = Object.values(checks).filter(Boolean).length;
  return {
    scorerVersion: WORKFLOW_VALUE_SCORER_VERSION,
    validationPassed: matchedConstraints === Object.keys(checks).length,
    matchedConstraints,
    totalConstraints: Object.keys(checks).length,
    checks,
  };
}
