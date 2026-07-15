import { type SemanticReferenceProvider } from "@sema-evals/adapters";
import { utf8Bytes } from "@sema-evals/core";

import {
  SIM_INPUT_USD_PER_TOKEN,
  SIM_OUTPUT_USD_PER_TOKEN,
  estimateTokens,
  opaqueRef,
  stablePretty,
} from "../context.js";
import type { SemaTaxScenario } from "../schemas.js";
import { sizeReuseDeliveryPolicy } from "./conditions.js";
import type {
  SemaTaxSizeReuseDelivery,
  SemaTaxSizeTier,
  SemaTaxSizedPattern,
} from "./schemas.js";

/** The scoreable core of a pattern — identical bytes across all size tiers, and
 * identical to the base design's rendered card. */
export function coreDefinition(
  pattern: SemaTaxSizedPattern,
): Record<string, unknown> {
  return {
    gloss: pattern.gloss,
    comparator: pattern.comparator,
    threshold: pattern.threshold,
    unit: pattern.unit,
  };
}

/**
 * The rendered definition for a pattern at a size tier: the scoreable core plus,
 * for medium and large, the tier's auxiliary specification content. The core
 * fields are always present and always identical, so ground truth is constant
 * across tiers; only the byte count varies.
 */
export function tierDefinition(
  pattern: SemaTaxSizedPattern,
  tier: SemaTaxSizeTier,
): Record<string, unknown> {
  const core = coreDefinition(pattern);
  if (tier === "small") {
    return core;
  }
  const aux = pattern.auxiliary[tier];
  return {
    ...core,
    rationale: aux.rationale,
    boundaryExamples: aux.boundaryExamples,
    edgeCaseNotes: aux.edgeCaseNotes,
  };
}

/** Canonical byte size of a pattern's definition at a tier (the enforced band). */
export function tierDefinitionBytes(
  pattern: SemaTaxSizedPattern,
  tier: SemaTaxSizeTier,
): number {
  return utf8Bytes(tierDefinition(pattern, tier));
}

export interface SizedActivePattern {
  handle: string;
  pattern: SemaTaxSizedPattern;
  definition: Record<string, unknown>;
}

/** The active set for the arm: the first N handles of the priority-ordered pool,
 * rendered at the requested tier. */
export function sizedActivePatterns(
  scenario: SemaTaxScenario,
  patternCount: number,
  tier: SemaTaxSizeTier,
  patternsByHandle: ReadonlyMap<string, SemaTaxSizedPattern>,
): SizedActivePattern[] {
  return scenario.patternPool.slice(0, patternCount).map((handle) => {
    const pattern = patternsByHandle.get(handle);
    if (!pattern) {
      throw new Error(
        `Scenario ${scenario.id} pool references unknown pattern ${handle}.`,
      );
    }
    return { handle, pattern, definition: tierDefinition(pattern, tier) };
  });
}

function definitionsMap(
  active: readonly SizedActivePattern[],
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

/**
 * The per-condition delivery template, shared by every message in an R-message
 * trial. The wire payload and reference block do not change from message to
 * message; only the token/hydration accounting does (a resolver arm hydrates the
 * definitions on the first message only). Assembled once per trial.
 */
export interface SizeReuseTemplate {
  active: SizedActivePattern[];
  /** The parity definitions block (tier-rendered), byte-identical across arms. */
  definitionsBlock: string;
  /** The reference block above the definitions (empty for prose). */
  referenceBlock: string;
  /** The structured wire payload for one message. */
  wirePayload: Record<string, unknown>;
  /** Bytes crossing the wire per message: full definitions (prose) or compact
   * references (resolver). Constant across the R messages. */
  wireBytesPerMessage: number;
  /** Bytes hydrated to resolve references, paid once (resolver, cold). 0 for
   * prose, which never hydrates. */
  definitionsHydrationBytes: number;
  /** Task + reference block + worksheet, present in every message. */
  suffixText: string;
  definitionsTokens: number;
  suffixTokens: number;
  hydratesOnFirstMessage: boolean;
}

/**
 * Assembles the per-condition template. Prose ships the full definitions on the
 * wire every message and never hydrates; the resolver arms ship compact
 * references every message and hydrate the identical definitions once (cold,
 * message 0). The definitions block is byte-identical across arms for a given
 * (scenario, tier) — information parity is preserved exactly as in the base
 * design, extended across size tiers.
 */
export async function assembleSizeReuseTemplate(
  scenario: SemaTaxScenario,
  patternCount: number,
  tier: SemaTaxSizeTier,
  delivery: SemaTaxSizeReuseDelivery,
  patternsByHandle: ReadonlyMap<string, SemaTaxSizedPattern>,
  referenceProvider: SemanticReferenceProvider,
): Promise<SizeReuseTemplate> {
  const policy = sizeReuseDeliveryPolicy(delivery);
  const active = sizedActivePatterns(
    scenario,
    patternCount,
    tier,
    patternsByHandle,
  );
  const defsMap = definitionsMap(active);
  const definitionsBlock =
    active.length > 0
      ? `## Resolved definitions\n${stablePretty(defsMap)}`
      : "";

  let referenceBlock = "";
  let wirePayload: Record<string, unknown>;
  let definitionsHydrationBytes = 0;

  if (policy.onWire === "inline-definitions") {
    wirePayload = {
      task: scenario.prompt,
      items: scenario.items,
      definitions: defsMap,
    };
  } else {
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
    referenceBlock = [
      heading,
      ...active.map(
        (entry) => `- ${entry.handle}: ${references[entry.handle]}`,
      ),
    ].join("\n");
    // Cold hydration fetches the full definitions once; reuse messages 1..R-1
    // rely on the already-resident definitions.
    definitionsHydrationBytes = utf8Bytes(defsMap);
  }

  const suffixText = [
    taskSection(scenario),
    referenceBlock,
    worksheetSection(scenario),
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");

  return {
    active,
    definitionsBlock,
    referenceBlock,
    wirePayload,
    wireBytesPerMessage: utf8Bytes(wirePayload),
    definitionsHydrationBytes,
    suffixText,
    definitionsTokens: estimateTokens(definitionsBlock),
    suffixTokens: estimateTokens(suffixText),
    hydratesOnFirstMessage: policy.hydratesFromRegistry,
  };
}

/** Per-message account inside an R-message trial. */
export interface MessageAccount {
  messageIndex: number;
  wireBytes: number;
  hydrationBytes: number;
  totalContextBytes: number;
  inputTokens: number;
  outputTokens: number;
  totalModelTokens: number;
  costUsd: number;
  /** The user turn a model receives this message (system prompt is on the
   * adapter). Prose carries the definitions every message; a resolver arm
   * carries them only on the hydrating first message. */
  messageText: string;
}

/**
 * Whether the definitions cross into the model's working context for a given
 * message. Prose re-sends them every message; a resolver arm hydrates them once
 * (message 0) and references them thereafter. This is the modeled amortization
 * the arm measures — see ADR 0013 for the deterministic token model and what it
 * does and does not claim.
 */
export function messageIncludesDefinitions(
  template: SizeReuseTemplate,
  messageIndex: number,
): boolean {
  if (!template.hydratesOnFirstMessage) {
    return true; // prose: definitions inline every message
  }
  return messageIndex === 0; // resolver: hydrate once
}

/**
 * Accounts one message. Wire bytes are paid every message; hydration bytes only
 * on the resolver's first message; definition tokens are billed whenever the
 * definitions are present for that message (prose: every message; resolver:
 * message 0). Output tokens come from the (deterministic or model) response.
 */
export function accountMessage(
  template: SizeReuseTemplate,
  messageIndex: number,
  responseText: string,
): MessageAccount {
  const includesDefs = messageIncludesDefinitions(template, messageIndex);
  const hydrationBytes =
    template.hydratesOnFirstMessage && messageIndex === 0
      ? template.definitionsHydrationBytes
      : 0;
  const inputTokens =
    template.suffixTokens + (includesDefs ? template.definitionsTokens : 0);
  const outputTokens = estimateTokens(responseText);
  const messageText = includesDefs
    ? [template.suffixText, template.definitionsBlock]
        .filter((section) => section.length > 0)
        .join("\n\n")
    : template.suffixText;
  const costUsd =
    inputTokens * SIM_INPUT_USD_PER_TOKEN +
    outputTokens * SIM_OUTPUT_USD_PER_TOKEN;
  return {
    messageIndex,
    wireBytes: template.wireBytesPerMessage,
    hydrationBytes,
    totalContextBytes: template.wireBytesPerMessage + hydrationBytes,
    inputTokens,
    outputTokens,
    totalModelTokens: inputTokens + outputTokens,
    costUsd,
    messageText,
  };
}
