import type {
  ModelAgentAdapter,
  ModelCompletion,
  ModelCompletionStatus,
  ModelPromptInput,
  SemanticReferenceProvider,
  Transcript,
  UsageTelemetry,
} from "@sema-evals/adapters";
import {
  utf8Bytes,
  type MatrixCell,
  type TrialEvent,
  type TrialProvenance,
} from "@sema-evals/core";

import { buildWorkflowDelivery, type WorkflowDelivery } from "./delivery.js";
import {
  parseWorkflowOutput,
  validateWorkflowOutput,
  WORKFLOW_VALUE_SCORER_VERSION,
} from "./scorer.js";
import { assertStructuredPromptTask } from "./runner.js";
import {
  WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE,
  WORKFLOW_TOTAL_TOKEN_BUDGET,
  workflowValueTrialRecordSchema,
  type WorkflowTask,
  type WorkflowValueCondition,
  type WorkflowValueMetrics,
  type WorkflowValueTrialRecord,
} from "./schemas.js";

export interface WorkflowTrialOptions {
  experimentId: string;
  datasetLabel: string;
  referenceProvider: SemanticReferenceProvider;
  provenance: TrialProvenance;
}

export interface ModelWorkflowTrialOptions extends WorkflowTrialOptions {
  adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion>;
}

interface TrialTelemetry {
  inputTokens: number;
  cachedInputTokensRead: number;
  cachedInputTokensWritten: number;
  reasoningTokens: number | null;
  outputTokens: number;
  attempts: number;
  retries: number;
  errors: readonly string[];
  costUsd: number | null;
  latencyMs: number;
}

interface CycleTelemetry {
  editTestCycles: number;
  failedEditTestCycles: number;
  regressions: number;
  reworkCycles: number;
  tokensToFirstPassingSolution: number | null;
}

function estimatedTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / 4);
}

function scriptedOutput(
  task: WorkflowTask,
  condition: WorkflowValueCondition,
): string {
  return JSON.stringify(
    condition === "task-only" ? task.localDraft : task.workflow.output,
  );
}

async function assembleTrial(params: {
  cell: MatrixCell<WorkflowTask, WorkflowValueCondition>;
  options: WorkflowTrialOptions;
  rawOutput: string;
  status: ModelCompletionStatus | null;
  telemetry: TrialTelemetry;
  cycles: CycleTelemetry;
  usage: UsageTelemetry | null;
  transcript: Transcript | null;
  delivery: WorkflowDelivery;
  started: number;
  startedAt: string;
}): Promise<WorkflowValueTrialRecord> {
  const { cell, options } = params;
  const delivery = params.delivery;
  const parsed = parseWorkflowOutput(params.rawOutput);
  const validation = validateWorkflowOutput(cell.scenario, parsed.output);
  const totalModelTokens =
    params.telemetry.inputTokens + params.telemetry.outputTokens;
  const withinTokenBudget = totalModelTokens <= WORKFLOW_TOTAL_TOKEN_BUDGET;
  const providerCompleted =
    params.status === null || params.status === "completed";
  const successWithinBudget =
    providerCompleted &&
    parsed.parseable &&
    validation.validationPassed &&
    withinTokenBudget;
  const repairNoticeProvided = delivery.mismatchNotice !== null;
  const repairApplied =
    repairNoticeProvided &&
    validation.validationPassed &&
    JSON.stringify(cell.scenario.localDraft) !== JSON.stringify(parsed.output);

  const events: TrialEvent[] = [];
  let sequence = 0;
  events.push({
    sequence: sequence++,
    type: "message",
    boundary: null,
    agent: "workflow-harness",
    details: {
      condition: cell.condition,
      wireBytes: delivery.wireBytes,
      workflowReference: delivery.workflowReference,
      opaqueReference: delivery.opaqueReference,
    },
  });
  if (delivery.hydrationBytes > 0) {
    events.push({
      sequence: sequence++,
      type: "hydration",
      boundary: null,
      agent: "workflow-executor",
      details: {
        hydrationBytes: delivery.hydrationBytes,
        resolver: options.referenceProvider.backend,
        workflowHandle: cell.scenario.workflow.handle,
      },
    });
  }
  if (repairNoticeProvided) {
    events.push({
      sequence: sequence++,
      type: "verification",
      boundary: null,
      agent: "workflow-harness",
      details: {
        mismatchFieldPath: cell.scenario.mismatch.fieldPath,
        explicitNotice: true,
        repairRequested: true,
      },
    });
  }
  events.push({
    sequence: sequence++,
    type: "completion",
    boundary: null,
    agent: "workflow-executor",
    details: {
      modelStatus: params.status,
      parseable: parsed.parseable,
      parseError: parsed.error,
      validationPassed: validation.validationPassed,
      matchedConstraints: validation.matchedConstraints,
      totalConstraints: validation.totalConstraints,
      withinTokenBudget,
      successWithinBudget,
      repairApplied,
      scorerVersion: WORKFLOW_VALUE_SCORER_VERSION,
    },
  });

  const metrics: WorkflowValueMetrics = {
    split: cell.scenario.split,
    parseFailure: !parsed.parseable,
    validationPassed: validation.validationPassed,
    successWithinBudget,
    withinTokenBudget,
    tokenBudget: WORKFLOW_TOTAL_TOKEN_BUDGET,
    invocationTokenReserve: WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE,
    matchedConstraints: validation.matchedConstraints,
    totalConstraints: validation.totalConstraints,
    repairNoticeProvided,
    repairApplied,
    wireBytes: delivery.wireBytes,
    hydrationBytes: delivery.hydrationBytes,
    totalSemanticBytes: delivery.wireBytes + delivery.hydrationBytes,
    inputTokens: params.telemetry.inputTokens,
    cachedInputTokensRead: params.telemetry.cachedInputTokensRead,
    cachedInputTokensWritten: params.telemetry.cachedInputTokensWritten,
    reasoningTokens: params.telemetry.reasoningTokens,
    outputTokens: params.telemetry.outputTokens,
    totalModelTokens,
    tokensToFirstPassingSolution: params.cycles.tokensToFirstPassingSolution,
    editTestCycles: params.cycles.editTestCycles,
    failedEditTestCycles: params.cycles.failedEditTestCycles,
    regressions: params.cycles.regressions,
    reworkCycles: params.cycles.reworkCycles,
    attempts: params.telemetry.attempts,
    retries: params.telemetry.retries,
    providerErrors: params.telemetry.errors.length,
    costUsd: params.telemetry.costUsd,
    modelLatencyMs: params.telemetry.latencyMs,
    elapsedMs: performance.now() - params.started,
  };

  return workflowValueTrialRecordSchema.parse({
    trialId: cell.trialId,
    experimentId: options.experimentId,
    scenarioId: cell.scenarioId,
    taskId: cell.scenario.id,
    datasetLabel: options.datasetLabel,
    split: cell.scenario.split,
    condition: cell.condition,
    seed: cell.seed,
    executionIndex: cell.executionIndex,
    startedAt: params.startedAt,
    completedAt: new Date().toISOString(),
    workflowReference: delivery.workflowReference,
    opaqueReference: delivery.opaqueReference,
    mismatchNotice: delivery.mismatchNotice,
    rawOutput: params.rawOutput,
    parsedOutput: parsed.output,
    modelCompletionStatus: params.status,
    events,
    metrics,
    provenance: options.provenance,
    usage: params.usage,
    transcript: params.transcript,
  });
}

export async function runDeterministicWorkflowTrial(
  cell: MatrixCell<WorkflowTask, WorkflowValueCondition>,
  options: WorkflowTrialOptions,
): Promise<WorkflowValueTrialRecord> {
  assertStructuredPromptTask(cell.scenario);
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const delivery = await buildWorkflowDelivery(
    cell.scenario,
    cell.condition,
    options.referenceProvider,
  );
  const rawOutput = scriptedOutput(cell.scenario, cell.condition);
  return assembleTrial({
    cell,
    options,
    rawOutput,
    status: null,
    telemetry: {
      inputTokens: estimatedTokens(delivery.userMessage),
      cachedInputTokensRead: 0,
      cachedInputTokensWritten: 0,
      reasoningTokens: null,
      outputTokens: estimatedTokens(rawOutput),
      attempts: 0,
      retries: 0,
      errors: [],
      costUsd: null,
      latencyMs: 0,
    },
    cycles: {
      editTestCycles: 1,
      failedEditTestCycles:
        rawOutput === JSON.stringify(cell.scenario.localDraft) ? 1 : 0,
      regressions: 0,
      reworkCycles: 0,
      tokensToFirstPassingSolution:
        rawOutput === JSON.stringify(cell.scenario.localDraft)
          ? null
          : estimatedTokens(delivery.userMessage) + estimatedTokens(rawOutput),
    },
    usage: null,
    transcript: null,
    delivery,
    started,
    startedAt,
  });
}

export async function runModelWorkflowTrial(
  cell: MatrixCell<WorkflowTask, WorkflowValueCondition>,
  options: ModelWorkflowTrialOptions,
): Promise<WorkflowValueTrialRecord> {
  assertStructuredPromptTask(cell.scenario);
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const delivery = await buildWorkflowDelivery(
    cell.scenario,
    cell.condition,
    options.referenceProvider,
  );
  const turns: ModelPromptInput["messages"][number][] = [
    { role: "user", content: delivery.userMessage },
  ];
  const usages: UsageTelemetry[] = [];
  const transcriptEntries: Transcript["entries"] = [];
  let rawOutput = "";
  let status: ModelCompletionStatus = "error";
  let stopReason: string | null = null;
  let editTestCycles = 0;
  let failedEditTestCycles = 0;
  let reworkCycles = 0;
  let tokensToFirstPassingSolution: number | null = null;

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const response = await options.adapter.invoke({ messages: [...turns] });
    editTestCycles += 1;
    rawOutput = response.output.text;
    status = response.output.status;
    stopReason = response.output.stopReason;
    usages.push(response.usage);
    for (const entry of response.transcript.entries) {
      transcriptEntries.push({ ...entry, index: transcriptEntries.length });
    }
    const parsed = parseWorkflowOutput(rawOutput);
    const validation = validateWorkflowOutput(cell.scenario, parsed.output);
    const tokensSoFar = usages.reduce(
      (total, usage) => total + usage.inputTokens + usage.outputTokens,
      0,
    );
    if (
      status === "completed" &&
      parsed.parseable &&
      validation.validationPassed
    ) {
      tokensToFirstPassingSolution = tokensSoFar;
      break;
    }
    failedEditTestCycles += 1;
    const remainingBudget = WORKFLOW_TOTAL_TOKEN_BUDGET - tokensSoFar;
    if (
      remainingBudget < WORKFLOW_MAX_INVOCATION_TOKEN_RESERVE ||
      cycle === 2
    ) {
      break;
    }
    turns.push({ role: "assistant", content: rawOutput });
    turns.push({
      role: "user",
      content:
        "The executable validator did not pass. Return a revised JSON object only.",
    });
    reworkCycles += 1;
  }
  const usage = mergeUsage(usages, stopReason);
  return assembleTrial({
    cell,
    options,
    rawOutput,
    status,
    telemetry: {
      inputTokens: usage.inputTokens,
      cachedInputTokensRead: usage.cachedInputTokensRead,
      cachedInputTokensWritten: usage.cachedInputTokensWritten,
      reasoningTokens: usage.reasoningTokens,
      outputTokens: usage.outputTokens,
      attempts: usage.attempts,
      retries: usage.retries,
      errors: usage.errors,
      costUsd: usage.costUsd,
      latencyMs: usage.latencyMs,
    },
    cycles: {
      editTestCycles,
      failedEditTestCycles,
      regressions: 0,
      reworkCycles,
      tokensToFirstPassingSolution,
    },
    usage,
    transcript: { entries: transcriptEntries },
    delivery,
    started,
    startedAt,
  });
}

function mergeUsage(
  usages: readonly UsageTelemetry[],
  stopReason: string | null,
): UsageTelemetry {
  const sum = (pick: (usage: UsageTelemetry) => number): number =>
    usages.reduce((total, usage) => total + pick(usage), 0);
  const reasoning = usages
    .map((usage) => usage.reasoningTokens)
    .filter((value): value is number => value !== null);
  const costs = usages
    .map((usage) => usage.costUsd)
    .filter((value): value is number => value !== null);
  return {
    inputTokens: sum((usage) => usage.inputTokens),
    cachedInputTokensRead: sum((usage) => usage.cachedInputTokensRead),
    cachedInputTokensWritten: sum((usage) => usage.cachedInputTokensWritten),
    reasoningTokens:
      reasoning.length === 0
        ? null
        : reasoning.reduce((total, value) => total + value, 0),
    outputTokens: sum((usage) => usage.outputTokens),
    attempts: sum((usage) => usage.attempts),
    retries: sum((usage) => usage.retries),
    errors: usages.flatMap((usage) => usage.errors),
    latencyMs: sum((usage) => usage.latencyMs),
    stopReason,
    costUsd:
      costs.length === 0
        ? null
        : costs.reduce((total, value) => total + value, 0),
  };
}
