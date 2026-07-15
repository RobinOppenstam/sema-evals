import { type Transcript, type UsageTelemetry } from "@sema-evals/adapters";
import {
  type MatrixCell,
  type TrialEvent,
  type TrialProvenance,
} from "@sema-evals/core";

import { parseCondition } from "./conditions.js";
import type { AssembledContext, TokenAccount } from "./context.js";
import {
  semaTaxTrialRecordSchema,
  type SemaTaxMetrics,
  type SemaTaxScenario,
  type SemaTaxTrialRecord,
} from "./schemas.js";
import type { WorksheetScore } from "./scorer.js";

/**
 * Assembles the metrics block shared by both executors from the assembled
 * context, the token account, and the worksheet score. Wire and hydration bytes
 * stay separate; the cache split is carried through from the token account.
 */
export function buildMetrics(
  condition: string,
  context: AssembledContext,
  tokens: TokenAccount,
  score: WorksheetScore,
  reasoningTokens: number | null,
  costUsd: number | null,
  elapsedMs: number,
): SemaTaxMetrics {
  const parts = parseCondition(condition);
  return {
    patternCount: parts.patternCount,
    delivery: parts.delivery,
    cacheState: parts.cacheState,
    activePatternCount: context.activePatterns.length,
    itemsTotal: score.itemsTotal,
    itemsAnswered: score.itemsAnswered,
    itemsCorrect: score.itemsCorrect,
    score: score.score,
    taskSuccess: score.taskSuccess,
    wireBytes: context.wireBytes,
    hydrationBytes: context.hydrationBytes,
    totalContextBytes: context.totalContextBytes,
    inputTokens: tokens.inputTokens,
    cachedInputTokensRead: tokens.cachedInputTokensRead,
    outputTokens: tokens.outputTokens,
    reasoningTokens,
    totalModelTokens: tokens.totalModelTokens,
    costUsd,
    elapsedMs,
  };
}

/**
 * Emits the standard event sequence for a tax trial: the wire message, an
 * optional hydration event (resolver arms only), and the scoring completion. No
 * relay boundary applies here, so every event's `boundary` is null.
 */
export function buildEvents(
  condition: string,
  context: AssembledContext,
  score: WorksheetScore,
  resolverBackend: string,
  executor: string,
): TrialEvent[] {
  const parts = parseCondition(condition);
  const events: TrialEvent[] = [];
  let sequence = 0;

  events.push({
    sequence: sequence++,
    type: "message",
    boundary: null,
    agent: "task-router",
    details: {
      transport: parts.delivery,
      wireBytes: context.wireBytes,
      activePatternCount: context.activePatterns.length,
      payload: context.wirePayload,
    },
  });

  if (context.hydrationBytes > 0 || parts.cacheState === "warm") {
    if (parts.delivery === "opaque" || parts.delivery === "content") {
      events.push({
        sequence: sequence++,
        type: "hydration",
        boundary: null,
        agent: "worksheet-agent",
        details: {
          hydrationBytes: context.hydrationBytes,
          cacheState: parts.cacheState,
          resolver: resolverBackend,
          referenceStyle: parts.delivery,
          activePatternCount: context.activePatterns.length,
        },
      });
    }
  }

  events.push({
    sequence: sequence++,
    type: "completion",
    boundary: null,
    agent: "worksheet-agent",
    details: {
      executor,
      scorerVersion: score.scorerVersion,
      itemsTotal: score.itemsTotal,
      itemsAnswered: score.itemsAnswered,
      itemsCorrect: score.itemsCorrect,
      score: score.score,
      taskSuccess: score.taskSuccess,
      perItem: score.perItem,
    },
  });

  return events;
}

/**
 * Builds and validates a complete tax trial record. Both executors funnel
 * through here so the record shape and its schema gate are identical.
 */
export function assembleRecord(params: {
  cell: MatrixCell<SemaTaxScenario, string>;
  experimentId: string;
  startedAt: string;
  completedAt: string;
  events: TrialEvent[];
  metrics: SemaTaxMetrics;
  provenance: TrialProvenance;
  usage: UsageTelemetry | null;
  transcript: Transcript | null;
}): SemaTaxTrialRecord {
  const record: SemaTaxTrialRecord = {
    trialId: params.cell.trialId,
    experimentId: params.experimentId,
    scenarioId: params.cell.scenarioId,
    condition: params.cell.condition,
    seed: params.cell.seed,
    executionIndex: params.cell.executionIndex,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    events: params.events,
    metrics: params.metrics,
    provenance: params.provenance,
    usage: params.usage,
    transcript: params.transcript,
  };
  return semaTaxTrialRecordSchema.parse(record);
}
