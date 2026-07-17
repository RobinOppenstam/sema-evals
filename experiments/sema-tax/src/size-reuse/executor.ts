import {
  type ModelAgentAdapter,
  type ModelCompletion,
  type ModelCompletionStatus,
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
import {
  SEMA_TAX_SCORER_VERSION,
  scoreWorksheet,
  type WorksheetScore,
} from "../scorer.js";
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
}

function messageMetric(
  account: MessageAccount,
  tokens: MessageTokens,
  score: WorksheetScore,
  completionStatus: ModelCompletionStatus | null,
  usage: UsageTelemetry | null,
): SemaTaxMessageMetrics {
  return {
    messageIndex: account.messageIndex,
    wireBytes: account.wireBytes,
    hydrationBytes: account.hydrationBytes,
    totalContextBytes: account.totalContextBytes,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalModelTokens: tokens.inputTokens + tokens.outputTokens,
    completionStatus,
    usage,
    itemsTotal: score.itemsTotal,
    itemsAnswered: score.itemsAnswered,
    itemsCorrect: score.itemsCorrect,
    score: score.score,
    taskSuccess:
      score.taskSuccess &&
      (completionStatus === null || completionStatus === "completed"),
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
  const modelMessages = messages.filter((message) => message.usage !== null);
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
    totalCachedInputTokensRead: modelMessages.reduce(
      (total, message) => total + (message.usage?.cachedInputTokensRead ?? 0),
      0,
    ),
    totalCachedInputTokensWritten: modelMessages.reduce(
      (total, message) =>
        total + (message.usage?.cachedInputTokensWritten ?? 0),
      0,
    ),
    totalOutputTokens,
    totalModelTokens: totalInputTokens + totalOutputTokens,
    itemsTotal: sum((m) => m.itemsTotal),
    itemsAnswered: sum((m) => m.itemsAnswered),
    itemsCorrect: sum((m) => m.itemsCorrect),
    score: messages.length === 0 ? 0 : sum((m) => m.score) / messages.length,
    taskSuccess: messages.every((m) => m.taskSuccess),
    modelFailureMessages: messages.filter(
      (message) =>
        message.completionStatus !== null &&
        message.completionStatus !== "completed",
    ).length,
    totalAttempts: modelMessages.reduce(
      (total, message) => total + (message.usage?.attempts ?? 0),
      0,
    ),
    totalRetries: modelMessages.reduce(
      (total, message) => total + (message.usage?.retries ?? 0),
      0,
    ),
    totalProviderErrors: modelMessages.reduce(
      (total, message) => total + (message.usage?.errors.length ?? 0),
      0,
    ),
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
        completionStatus: message.completionStatus,
        providerErrors: message.usage?.errors ?? [],
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
      scorerVersion: SEMA_TAX_SCORER_VERSION,
      itemsCorrect: messages.reduce((t, m) => t + m.itemsCorrect, 0),
      itemsTotal: messages.reduce((t, m) => t + m.itemsTotal, 0),
      taskSuccess: messages.every((message) => message.taskSuccess),
      modelFailureMessages: messages.filter(
        (message) =>
          message.completionStatus !== null &&
          message.completionStatus !== "completed",
      ).length,
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
        },
        score,
        null,
        null,
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
  const messageUsages: UsageTelemetry[] = [];

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
    messageUsages.push(usage);
    messages.push(
      messageMetric(
        account,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
        score,
        response.output.status,
        usage,
      ),
    );
  }

  const completedAt = new Date().toISOString();
  const mergedUsage = mergeUsageTelemetry(messageUsages);
  const metrics = rollup(
    cell.condition,
    template,
    messages,
    mergedUsage.reasoningTokens,
    mergedUsage.costUsd,
    performance.now() - started,
  );
  const events = buildSizeReuseEvents(
    cell.condition,
    template,
    messages,
    options.referenceProvider.backend,
    MODEL_EXECUTOR,
  );

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

/** Merges provider telemetry from the R sequential calls without replacing
 * observed retry, cache, error, latency, stop, reasoning, or cost fields with
 * harness defaults. Per-message copies remain in `metrics.messages`. */
function mergeUsageTelemetry(
  usages: readonly UsageTelemetry[],
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
    stopReason: usages.at(-1)?.stopReason ?? null,
    costUsd:
      costs.length === 0
        ? null
        : costs.reduce((total, value) => total + value, 0),
  };
}
