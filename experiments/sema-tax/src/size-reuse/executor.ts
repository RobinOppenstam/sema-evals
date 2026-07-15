import {
  type ModelAgentAdapter,
  type ModelCompletion,
  type ModelInputMessage,
  type ModelPromptInput,
  type SemanticReferenceProvider,
  type Transcript,
  type UsageTelemetry,
} from "@sema-evals/adapters";
import {
  type MatrixCell,
  type TrialEvent,
  type TrialProvenance,
} from "@sema-evals/core";

import type { SemaTaxScenario } from "../schemas.js";
import { scoreWorksheet, type WorksheetScore } from "../scorer.js";
import { simulateResponse } from "../tax.js";
import {
  accountMessage,
  assembleSizeReuseTemplate,
  type MessageAccount,
  type SizeReuseTemplate,
} from "./context.js";
import { parseSizeReuseCondition } from "./conditions.js";
import {
  semaTaxSizeReuseTrialRecordSchema,
  type SemaTaxMessageMetrics,
  type SemaTaxSizeReuseMetrics,
  type SemaTaxSizeReuseTrialRecord,
  type SemaTaxSizedPattern,
} from "./schemas.js";

const DETERMINISTIC_EXECUTOR = "deterministic-simulator";
const MODEL_EXECUTOR = "model-pilot";

export interface SizeReuseTrialOptions {
  experimentId: string;
  referenceProvider: SemanticReferenceProvider;
  patternsByHandle: ReadonlyMap<string, SemaTaxSizedPattern>;
  provenance: TrialProvenance;
}

export interface ModelSizeReuseTrialOptions extends SizeReuseTrialOptions {
  adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion>;
}

/** Token fields for one message, either simulated or provider-reported. */
interface MessageTokens {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

function messageMetric(
  account: MessageAccount,
  tokens: MessageTokens,
  score: WorksheetScore,
): SemaTaxMessageMetrics {
  return {
    messageIndex: account.messageIndex,
    wireBytes: account.wireBytes,
    hydrationBytes: account.hydrationBytes,
    totalContextBytes: account.totalContextBytes,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalModelTokens: tokens.inputTokens + tokens.outputTokens,
    itemsTotal: score.itemsTotal,
    itemsAnswered: score.itemsAnswered,
    itemsCorrect: score.itemsCorrect,
    score: score.score,
    taskSuccess: score.taskSuccess,
  };
}

/** Rolls the per-message metrics up to the trial-level metrics block. Cumulative
 * byte and token channels sum; score is the mean per-message score; item counts
 * sum. */
function rollup(
  condition: string,
  template: SizeReuseTemplate,
  messages: readonly SemaTaxMessageMetrics[],
  reasoningTokens: number | null,
  costUsd: number | null,
  elapsedMs: number,
): SemaTaxSizeReuseMetrics {
  const parts = parseSizeReuseCondition(condition);
  const sum = (pick: (m: SemaTaxMessageMetrics) => number): number =>
    messages.reduce((total, m) => total + pick(m), 0);
  const cumulativeWireBytes = sum((m) => m.wireBytes);
  const cumulativeHydrationBytes = sum((m) => m.hydrationBytes);
  const totalInputTokens = sum((m) => m.inputTokens);
  const totalOutputTokens = sum((m) => m.outputTokens);
  return {
    patternCount: parts.patternCount,
    size: parts.size,
    reuse: parts.reuse,
    delivery: parts.delivery,
    cacheState: "cold",
    activePatternCount: template.active.length,
    messages: [...messages],
    cumulativeWireBytes,
    cumulativeHydrationBytes,
    totalSemanticBytes: cumulativeWireBytes + cumulativeHydrationBytes,
    totalInputTokens,
    totalOutputTokens,
    totalModelTokens: totalInputTokens + totalOutputTokens,
    itemsTotal: sum((m) => m.itemsTotal),
    itemsAnswered: sum((m) => m.itemsAnswered),
    itemsCorrect: sum((m) => m.itemsCorrect),
    score: messages.length === 0 ? 0 : sum((m) => m.score) / messages.length,
    taskSuccess: messages.every((m) => m.taskSuccess),
    reasoningTokens,
    costUsd,
    elapsedMs,
  };
}

/** Emits the event stream for an R-message trial: one message event per message,
 * a hydration event on the resolver's first message, and a final completion. */
function buildSizeReuseEvents(
  condition: string,
  template: SizeReuseTemplate,
  messages: readonly SemaTaxMessageMetrics[],
  resolverBackend: string,
  executor: string,
): TrialEvent[] {
  const parts = parseSizeReuseCondition(condition);
  const events: TrialEvent[] = [];
  let sequence = 0;

  messages.forEach((message) => {
    events.push({
      sequence: sequence++,
      type: "message",
      boundary: null,
      agent: "task-router",
      details: {
        transport: parts.delivery,
        size: parts.size,
        messageIndex: message.messageIndex,
        wireBytes: message.wireBytes,
        activePatternCount: template.active.length,
      },
    });
    if (message.hydrationBytes > 0) {
      events.push({
        sequence: sequence++,
        type: "hydration",
        boundary: null,
        agent: "worksheet-agent",
        details: {
          hydrationBytes: message.hydrationBytes,
          cacheState: "cold",
          resolver: resolverBackend,
          referenceStyle: parts.delivery,
          messageIndex: message.messageIndex,
          activePatternCount: template.active.length,
        },
      });
    }
  });

  events.push({
    sequence: sequence++,
    type: "completion",
    boundary: null,
    agent: "worksheet-agent",
    details: {
      executor,
      reuse: parts.reuse,
      size: parts.size,
      messageCount: messages.length,
      scorerVersion: "sema-tax-worksheet-scorer-v2",
      itemsCorrect: messages.reduce((t, m) => t + m.itemsCorrect, 0),
      itemsTotal: messages.reduce((t, m) => t + m.itemsTotal, 0),
    },
  });

  return events;
}

function assembleSizeReuseRecord(params: {
  cell: MatrixCell<SemaTaxScenario, string>;
  experimentId: string;
  startedAt: string;
  completedAt: string;
  events: TrialEvent[];
  metrics: SemaTaxSizeReuseMetrics;
  provenance: TrialProvenance;
  usage: UsageTelemetry | null;
  transcript: Transcript | null;
}): SemaTaxSizeReuseTrialRecord {
  return semaTaxSizeReuseTrialRecordSchema.parse({
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
  } satisfies SemaTaxSizeReuseTrialRecord);
}

/**
 * Runs one deterministic size/reuse trial: R sequential worksheet messages in
 * one conversation, scripted by the same active-set rule as the base arm. Every
 * metric channel — per-message wire, one-time hydration, per-message tokens, the
 * cumulative rollup, cost, and graded quality — is exercised with exact,
 * test-checked values. No model is called; usage and transcript are null.
 */
export async function runSimulatedSizeReuseTrial(
  cell: MatrixCell<SemaTaxScenario, string>,
  options: SizeReuseTrialOptions,
): Promise<SemaTaxSizeReuseTrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const parts = parseSizeReuseCondition(cell.condition);

  const template = await assembleSizeReuseTemplate(
    cell.scenario,
    parts.patternCount,
    parts.size,
    parts.delivery,
    options.patternsByHandle,
    options.referenceProvider,
  );
  const activeHandles = new Set(template.active.map((entry) => entry.handle));
  const responseText = simulateResponse(
    cell.scenario,
    activeHandles,
    options.patternsByHandle,
  );
  const score = scoreWorksheet(
    cell.scenario.items,
    options.patternsByHandle,
    responseText,
  );

  const messages: SemaTaxMessageMetrics[] = [];
  let costUsd = 0;
  for (let index = 0; index < parts.reuse; index += 1) {
    const account = accountMessage(template, index, responseText);
    costUsd += account.costUsd;
    messages.push(
      messageMetric(
        account,
        {
          inputTokens: account.inputTokens,
          outputTokens: account.outputTokens,
          costUsd: account.costUsd,
        },
        score,
      ),
    );
  }

  const completedAt = new Date().toISOString();
  const metrics = rollup(
    cell.condition,
    template,
    messages,
    null,
    costUsd,
    performance.now() - started,
  );
  const events = buildSizeReuseEvents(
    cell.condition,
    template,
    messages,
    options.referenceProvider.backend,
    DETERMINISTIC_EXECUTOR,
  );

  return assembleSizeReuseRecord({
    cell,
    experimentId: options.experimentId,
    startedAt,
    completedAt,
    events,
    metrics,
    provenance: options.provenance,
    usage: null,
    transcript: null,
  });
}

/**
 * Runs one model-pilot size/reuse trial. The R messages form a real growing
 * conversation: each turn appends the prior user/assistant turns so the resolver
 * arm's message-0 hydration persists in history for later references. Wire and
 * hydration bytes are computed harness-side exactly as in the deterministic path;
 * tokens, cost, and transcript come from the provider. Non-completed calls are
 * preserved (their possibly-empty text scores zero, transcript retained). Wired
 * but not run in CI — model-pilot mode requires a provider key.
 */
export async function runModelSizeReuseTrial(
  cell: MatrixCell<SemaTaxScenario, string>,
  options: ModelSizeReuseTrialOptions,
): Promise<SemaTaxSizeReuseTrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const parts = parseSizeReuseCondition(cell.condition);

  const template = await assembleSizeReuseTemplate(
    cell.scenario,
    parts.patternCount,
    parts.size,
    parts.delivery,
    options.patternsByHandle,
    options.referenceProvider,
  );

  const turns: ModelInputMessage[] = [];
  const transcriptEntries: Transcript["entries"] = [];
  const messages: SemaTaxMessageMetrics[] = [];
  let reasoningTokens: number | null = null;
  let costUsd: number | null = null;
  let anyCost = false;

  for (let index = 0; index < parts.reuse; index += 1) {
    const account = accountMessage(template, index, "");
    turns.push({ role: "user", content: account.messageText });
    const response = await options.adapter.invoke({ messages: [...turns] });
    const responseText = response.output.text;
    turns.push({ role: "assistant", content: responseText });

    for (const entry of response.transcript.entries) {
      transcriptEntries.push({ ...entry, index: transcriptEntries.length });
    }

    const score = scoreWorksheet(
      cell.scenario.items,
      options.patternsByHandle,
      responseText,
    );
    const usage = response.usage;
    if (usage.reasoningTokens !== null) {
      reasoningTokens = (reasoningTokens ?? 0) + usage.reasoningTokens;
    }
    if (usage.costUsd !== null) {
      costUsd = (costUsd ?? 0) + usage.costUsd;
      anyCost = true;
    }
    messages.push(
      messageMetric(
        account,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: usage.costUsd,
        },
        score,
      ),
    );
  }

  const completedAt = new Date().toISOString();
  const metrics = rollup(
    cell.condition,
    template,
    messages,
    reasoningTokens,
    anyCost ? costUsd : null,
    performance.now() - started,
  );
  const events = buildSizeReuseEvents(
    cell.condition,
    template,
    messages,
    options.referenceProvider.backend,
    MODEL_EXECUTOR,
  );

  // Preserve the full multi-turn conversation as one merged transcript.
  const mergedUsage: UsageTelemetry = {
    inputTokens: metrics.totalInputTokens,
    cachedInputTokensRead: 0,
    cachedInputTokensWritten: 0,
    reasoningTokens,
    outputTokens: metrics.totalOutputTokens,
    attempts: parts.reuse,
    retries: 0,
    errors: [],
    latencyMs: metrics.elapsedMs,
    stopReason: null,
    costUsd: anyCost ? costUsd : null,
  };

  return assembleSizeReuseRecord({
    cell,
    experimentId: options.experimentId,
    startedAt,
    completedAt,
    events,
    metrics,
    provenance: options.provenance,
    usage: mergedUsage,
    transcript: { entries: transcriptEntries },
  });
}
