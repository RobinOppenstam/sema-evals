import { type SemanticReferenceProvider } from "@sema-evals/adapters";
import { type MatrixCell } from "@sema-evals/core";

import { parseCondition } from "./conditions.js";
import { accountTokens, assembleContext } from "./context.js";
import type {
  SemaTaxPattern,
  SemaTaxScenario,
  SemaTaxTrialRecord,
} from "./schemas.js";
import { evaluateItem, scoreWorksheet } from "./scorer.js";
import { assembleRecord, buildEvents, buildMetrics } from "./trial.js";
import type { TrialProvenance } from "@sema-evals/core";

const DETERMINISTIC_EXECUTOR = "deterministic-simulator";

export interface SimulatedTaxTrialOptions {
  experimentId: string;
  referenceProvider: SemanticReferenceProvider;
  patternsByHandle: ReadonlyMap<string, SemaTaxPattern>;
  provenance: TrialProvenance;
}

/**
 * The scripted worksheet agent: it answers an item correctly exactly when the
 * item's pattern is in the active set (its definition was delivered), and emits
 * `unknown` otherwise. This makes the graded score equal the active-set
 * coverage of the worksheet — the benefit side of the tax curve — with no model
 * call and no randomness, so every aggregate is exactly reproducible.
 */
export function simulateResponse(
  scenario: SemaTaxScenario,
  activeHandles: ReadonlySet<string>,
  patternsByHandle: ReadonlyMap<string, SemaTaxPattern>,
): string {
  return scenario.items
    .map((item) => {
      if (!activeHandles.has(item.patternHandle)) {
        return `ITEM ${item.id}: unknown`;
      }
      const pattern = patternsByHandle.get(item.patternHandle);
      if (!pattern) {
        throw new Error(
          `Item ${item.id} references unknown pattern ${item.patternHandle}.`,
        );
      }
      return `ITEM ${item.id}: ${evaluateItem(pattern, item.value)}`;
    })
    .join("\n");
}

/**
 * Runs one deterministic tax trial. The full condition matrix runs through this
 * path with a scripted executor, exercising every metric channel — wire bytes,
 * hydration bytes, the cold/warm token split, cost, and quality — with exact,
 * test-checked values. No model is called and `usage`/`transcript` are null, as
 * in the deterministic Babel Relay.
 */
export async function runSimulatedTaxTrial(
  cell: MatrixCell<SemaTaxScenario, string>,
  options: SimulatedTaxTrialOptions,
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
  const activeHandles = new Set(
    context.activePatterns.map((entry) => entry.handle),
  );
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
  const tokens = accountTokens(context, parts.cacheState, responseText);

  const completedAt = new Date().toISOString();
  const elapsedMs = performance.now() - started;

  const metrics = buildMetrics(
    cell.condition,
    context,
    tokens,
    score,
    null,
    tokens.costUsd,
    elapsedMs,
  );
  const events = buildEvents(
    cell.condition,
    context,
    score,
    options.referenceProvider.backend,
    DETERMINISTIC_EXECUTOR,
  );

  return assembleRecord({
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
