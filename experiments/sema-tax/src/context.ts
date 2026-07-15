import { type SemanticReferenceProvider } from "@sema-evals/adapters";
import { stableJson, utf8Bytes } from "@sema-evals/core";

import {
  deliveryPolicy,
  type SemaTaxCacheState,
  type SemaTaxConditionParts,
} from "./conditions.js";
import type { SemaTaxPattern, SemaTaxScenario } from "./schemas.js";

/** Illustrative token prices for the deterministic simulator only. They are not
 * a real provider's pricing; model-pilot runs carry the provider's own cost (or
 * null). Cached input reads are billed at a fraction of fresh input, so the warm
 * cache arm is cheaper without changing token throughput. */
export const SIM_INPUT_USD_PER_TOKEN = 3e-6;
export const SIM_CACHED_INPUT_USD_PER_TOKEN = 0.3e-6;
export const SIM_OUTPUT_USD_PER_TOKEN = 15e-6;

/** A simple, deterministic token estimate (~4 bytes/token). Used only to
 * exercise the token pathways in the deterministic harness with exact,
 * reproducible values; real token counts come from the provider in model-pilot
 * mode. */
export function estimateTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / 4);
}

/** Byte-stable pretty rendering with sorted keys, so the resolved-definitions
 * block is byte-identical regardless of delivery arm or cache state. */
export function stablePretty(value: unknown): string {
  return JSON.stringify(JSON.parse(stableJson(value)), null, 2);
}

/** The rendered semantic card for a pattern (everything but its handle key). */
export function patternDefinition(
  pattern: SemaTaxPattern,
): Record<string, unknown> {
  return {
    gloss: pattern.gloss,
    comparator: pattern.comparator,
    threshold: pattern.threshold,
    unit: pattern.unit,
  };
}

/** A stable, content-free opaque lookup label. It never changes with the
 * definition, so it controls for compact lookup without revealing drift. */
export function opaqueRef(handle: string): string {
  return `pattern:${handle.toLowerCase()}-v1`;
}

export interface ActivePattern {
  handle: string;
  pattern: SemaTaxPattern;
  definition: Record<string, unknown>;
}

/**
 * The active pattern set for a pattern count: the first N handles of the
 * scenario's priority-ordered pool. Selection is seed-independent, so the
 * deterministic harness produces identical active sets across repetitions (its
 * between-run variance is therefore zero — an honest property of a scripted
 * executor, exercised by real models in model-pilot mode).
 */
export function activePatterns(
  scenario: SemaTaxScenario,
  patternCount: number,
  patternsByHandle: ReadonlyMap<string, SemaTaxPattern>,
): ActivePattern[] {
  return scenario.patternPool.slice(0, patternCount).map((handle) => {
    const pattern = patternsByHandle.get(handle);
    if (!pattern) {
      throw new Error(
        `Scenario ${scenario.id} pool references unknown pattern ${handle}.`,
      );
    }
    return { handle, pattern, definition: patternDefinition(pattern) };
  });
}

function definitionsMap(
  active: readonly ActivePattern[],
): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const entry of active) {
    map[entry.handle] = entry.definition;
  }
  return map;
}

function taskSection(scenario: SemaTaxScenario): string {
  return `## Task\n${scenario.prompt}`;
}

function worksheetSection(scenario: SemaTaxScenario): string {
  const lines = scenario.items.map(
    (item) =>
      `- ITEM ${item.id}: does value ${item.value} satisfy pattern ${item.patternHandle}?`,
  );
  return [
    "## Worksheet",
    "Answer every item with a strict line of the form `ITEM <id>: yes` or `ITEM <id>: no`.",
    ...lines,
  ].join("\n");
}

export interface TokenAccount {
  inputTokens: number;
  cachedInputTokensRead: number;
  outputTokens: number;
  totalModelTokens: number;
  costUsd: number;
}

export interface AssembledContext {
  activePatterns: ActivePattern[];
  /** The structured wire payload before any hydration. */
  wirePayload: Record<string, unknown>;
  wireBytes: number;
  hydrationBytes: number;
  totalContextBytes: number;
  /** The parity block: byte-identical across delivery arms and cache states for
   * a given active set. Empty for the baseline. */
  definitionsBlock: string;
  /** The reference block above the parity block. Empty for baseline and prose. */
  referenceBlock: string;
  /** The full user message a model receives (system prompt is on the adapter). */
  userMessage: string;
  /** The cacheable prefix (the parity definitions block). */
  cachedPrefixText: string;
  /** The task-specific suffix (task + references + worksheet). */
  freshSuffixText: string;
}

/**
 * Assembles the wire payload, hydration cost, and the model-visible context for
 * one condition. The resolved-definitions block is byte-identical across the
 * prose, opaque, and content arms (information parity); only the wire payload,
 * the reference block, and the hydration cost differ. Cold vs warm changes only
 * where the definition tokens are billed, computed later in {@link accountTokens}.
 */
export async function assembleContext(
  scenario: SemaTaxScenario,
  parts: SemaTaxConditionParts,
  patternsByHandle: ReadonlyMap<string, SemaTaxPattern>,
  referenceProvider: SemanticReferenceProvider,
): Promise<AssembledContext> {
  const policy = deliveryPolicy(parts.delivery);
  const active = activePatterns(scenario, parts.patternCount, patternsByHandle);
  const defsMap = definitionsMap(active);

  const definitionsBlock =
    active.length > 0
      ? `## Resolved definitions\n${stablePretty(defsMap)}`
      : "";

  let referenceBlock = "";
  let wirePayload: Record<string, unknown>;

  if (policy.onWire === "task-only") {
    wirePayload = {
      task: scenario.prompt,
      items: scenario.items,
    };
  } else if (policy.onWire === "inline-definitions") {
    wirePayload = {
      task: scenario.prompt,
      items: scenario.items,
      definitions: defsMap,
    };
  } else {
    // Resolver arms ship only compact references on the wire.
    const references: Record<string, string> = {};
    for (const entry of active) {
      references[entry.handle] =
        policy.referenceStyle === "opaque"
          ? opaqueRef(entry.handle)
          : (await referenceProvider.reference(entry.handle, entry.definition))
              .full;
    }
    wirePayload = {
      task: scenario.prompt,
      items: scenario.items,
      references,
    };
    const heading =
      policy.referenceStyle === "opaque"
        ? "## Semantic references (opaque lookup)"
        : "## Semantic references (content-addressed)";
    const refLines = active.map(
      (entry) => `- ${entry.handle}: ${references[entry.handle]}`,
    );
    referenceBlock = [heading, ...refLines].join("\n");
  }

  const wireBytes = utf8Bytes(wirePayload);
  // Cold hydration fetches the full definitions from the registry; a warm cache
  // serves them locally, so no bytes cross the resolver boundary.
  const hydrationBytes =
    policy.hydratesFromRegistry && parts.cacheState === "cold"
      ? utf8Bytes(defsMap)
      : 0;

  const freshSuffixText = [
    taskSection(scenario),
    referenceBlock,
    worksheetSection(scenario),
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
  const cachedPrefixText = definitionsBlock;
  const userMessage = [freshSuffixText, cachedPrefixText]
    .filter((section) => section.length > 0)
    .join("\n\n");

  return {
    activePatterns: active,
    wirePayload,
    wireBytes,
    hydrationBytes,
    totalContextBytes: wireBytes + hydrationBytes,
    definitionsBlock,
    referenceBlock,
    userMessage,
    cachedPrefixText,
    freshSuffixText,
  };
}

/**
 * Simulated token accounting for the deterministic harness. The cacheable
 * prefix (the definitions block) contributes to `inputTokens` in both cache
 * states — total throughput is cache-agnostic, matching provider accounting —
 * but on a warm cache those prefix tokens are also reported as
 * `cachedInputTokensRead` and billed at the cheaper cached rate. `outputTokens`
 * comes from the response text. `totalModelTokens` (the primary-endpoint
 * denominator) is input + output throughput.
 */
export function accountTokens(
  context: AssembledContext,
  cacheState: SemaTaxCacheState,
  responseText: string,
): TokenAccount {
  const prefixTokens = estimateTokens(context.cachedPrefixText);
  const suffixTokens = estimateTokens(context.freshSuffixText);
  const inputTokens = prefixTokens + suffixTokens;
  const cachedInputTokensRead = cacheState === "warm" ? prefixTokens : 0;
  const outputTokens = estimateTokens(responseText);
  const costUsd =
    (inputTokens - cachedInputTokensRead) * SIM_INPUT_USD_PER_TOKEN +
    cachedInputTokensRead * SIM_CACHED_INPUT_USD_PER_TOKEN +
    outputTokens * SIM_OUTPUT_USD_PER_TOKEN;
  return {
    inputTokens,
    cachedInputTokensRead,
    outputTokens,
    totalModelTokens: inputTokens + outputTokens,
    costUsd,
  };
}
