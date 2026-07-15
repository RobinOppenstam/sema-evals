import {
  type ModelAgentAdapter,
  type ModelCompletion,
  type ModelPromptInput,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";
import { type MatrixCell, type TrialProvenance } from "@sema-evals/core";

import { parseCondition } from "./conditions.js";
import { assembleContext, type TokenAccount } from "./context.js";
import type {
  SemaTaxPattern,
  SemaTaxScenario,
  SemaTaxTrialRecord,
} from "./schemas.js";
import { scoreWorksheet } from "./scorer.js";
import { assembleRecord, buildEvents, buildMetrics } from "./trial.js";

const MODEL_EXECUTOR = "model-pilot";

export interface ModelTaxTrialOptions {
  experimentId: string;
  referenceProvider: SemanticReferenceProvider;
  patternsByHandle: ReadonlyMap<string, SemaTaxPattern>;
  provenance: TrialProvenance;
  /** One worksheet-solver adapter, constructed once per run. */
  adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion>;
}

/**
 * Runs one model-pilot tax trial. The wire and hydration costs are computed
 * harness-side exactly as in the deterministic path (so byte channels stay
 * comparable), while the token account, cost, and transcript come from the real
 * model call. A non-completed call is preserved as a failure: its (possibly
 * empty) text scores zero and the transcript is retained, never dropped. The
 * worksheet scorer parses the model's `ITEM <id>: yes|no` lines objectively —
 * no LLM judge is the source of truth.
 */
export async function runModelTaxTrial(
  cell: MatrixCell<SemaTaxScenario, string>,
  options: ModelTaxTrialOptions,
): Promise<SemaTaxTrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const parts = parseCondition(cell.condition);

  const context = await assembleContext(
    cell.scenario,
    parts,
    options.patternsByHandle,
    options.referenceProvider,
  );

  const response = await options.adapter.invoke({
    messages: [{ role: "user", content: context.userMessage }],
  });
  const responseText = response.output.text;
  const score = scoreWorksheet(
    cell.scenario.items,
    options.patternsByHandle,
    responseText,
  );

  const usage = response.usage;
  const tokens: TokenAccount = {
    inputTokens: usage.inputTokens,
    cachedInputTokensRead: usage.cachedInputTokensRead,
    outputTokens: usage.outputTokens,
    totalModelTokens: usage.inputTokens + usage.outputTokens,
    costUsd: usage.costUsd ?? 0,
  };

  const completedAt = new Date().toISOString();
  const elapsedMs = performance.now() - started;

  const metrics = buildMetrics(
    cell.condition,
    context,
    tokens,
    score,
    usage.reasoningTokens,
    usage.costUsd,
    elapsedMs,
  );
  const events = buildEvents(
    cell.condition,
    context,
    score,
    options.referenceProvider.backend,
    MODEL_EXECUTOR,
  );

  return assembleRecord({
    cell,
    experimentId: options.experimentId,
    startedAt,
    completedAt,
    events,
    metrics,
    provenance: options.provenance,
    usage,
    transcript: response.transcript,
  });
}
