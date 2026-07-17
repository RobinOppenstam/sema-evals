import type {
  ModelCompletionStatus,
  Transcript,
  UsageTelemetry,
} from "@sema-evals/adapters";

import type { WorkflowValueCondition, WorkflowTask } from "./schemas.js";

export const STRUCTURED_PROMPT_RUNNER = {
  id: "structured-json-prompt-runner-v1",
  contractKind: "structured-json",
  tools: "none",
  workspaceWrites: false,
} as const;

export interface WorkspaceCommandTelemetry {
  argv: string[];
  exitCode: number;
  elapsedMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface AgentWorkflowRunnerResult {
  rawOutput: string;
  status: ModelCompletionStatus;
  usage: UsageTelemetry;
  transcript: Transcript;
  changedPaths: string[];
  commands: WorkspaceCommandTelemetry[];
  validatorRuns: number;
  failedEditTestCycles: number;
  regressions: number;
  reworkCycles: number;
  tokensToFirstPassingSolution: number | null;
}

/**
 * Future repository-workspace tasks require a controlled tool/workspace layer
 * beyond a completion adapter. Implementations must enforce allowed paths and
 * capture every command and validator run.
 */
export interface AgentWorkflowRunner {
  readonly id: string;
  readonly contractKind: "repository-workspace";
  run(input: {
    task: WorkflowTask;
    condition: WorkflowValueCondition;
    tokenBudget: number;
    invocationTokenReserve: number;
  }): Promise<AgentWorkflowRunnerResult>;
}

export function assertStructuredPromptTask(task: WorkflowTask): void {
  if (task.contract.kind !== STRUCTURED_PROMPT_RUNNER.contractKind) {
    throw new Error(
      `Workflow task ${task.id} uses unsupported ${task.contract.kind} contract. Supply a controlled AgentWorkflowRunner; the prompt-only runner fails closed.`,
    );
  }
}
