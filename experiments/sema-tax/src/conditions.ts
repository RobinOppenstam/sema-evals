/**
 * The Sema tax curve condition space is a full crossing of three factors:
 *
 * - active pattern count in {0, 2, 4, 8, 12, 16};
 * - delivery in {full prose, opaque resolver, content-addressed resolver};
 * - cache in {cold hydration, warm cache}.
 *
 * The zero-pattern level is a single shared anchor: with no patterns there is
 * nothing to deliver and nothing to hydrate, so delivery and cache are
 * undefined there. Encoding it as one `p0-baseline` condition (rather than six
 * byte-identical baseline cells) keeps the baseline sample honest and gives all
 * three delivery curves the same count=0 origin. Every other level is fully
 * crossed: 5 counts x 3 deliveries x 2 caches = 30, plus the anchor = 31.
 */

export const SEMA_TAX_PATTERN_COUNTS = [0, 2, 4, 8, 12, 16] as const;
export const SEMA_TAX_DELIVERIES = ["prose", "opaque", "content"] as const;
export const SEMA_TAX_CACHE_STATES = ["cold", "warm"] as const;

export type SemaTaxPatternCount = (typeof SEMA_TAX_PATTERN_COUNTS)[number];
export type SemaTaxDeliveryArm = (typeof SEMA_TAX_DELIVERIES)[number];
export type SemaTaxCacheArm = (typeof SEMA_TAX_CACHE_STATES)[number];

/** `baseline` and `none` are the degenerate zero-pattern values. */
export type SemaTaxDelivery = "baseline" | SemaTaxDeliveryArm;
export type SemaTaxCacheState = "none" | SemaTaxCacheArm;

export interface SemaTaxConditionParts {
  patternCount: number;
  delivery: SemaTaxDelivery;
  cacheState: SemaTaxCacheState;
}

const CONDITION_PATTERN =
  /^p(\d+)-(?:baseline|(prose|opaque|content)-(cold|warm))$/;

/** Builds the canonical condition id from its decomposed parts. */
export function conditionId(parts: SemaTaxConditionParts): string {
  if (parts.patternCount === 0) {
    return "p0-baseline";
  }
  return `p${parts.patternCount}-${parts.delivery}-${parts.cacheState}`;
}

/** Parses a condition id back into its decomposed parts. Throws on a malformed
 * id so a typo can never silently create a phantom condition. */
export function parseCondition(id: string): SemaTaxConditionParts {
  const match = CONDITION_PATTERN.exec(id);
  if (!match) {
    throw new Error(`Malformed sema-tax condition id: ${id}`);
  }
  const patternCount = Number(match[1]);
  if (patternCount === 0) {
    return { patternCount: 0, delivery: "baseline", cacheState: "none" };
  }
  return {
    patternCount,
    delivery: match[2] as SemaTaxDeliveryArm,
    cacheState: match[3] as SemaTaxCacheArm,
  };
}

/**
 * The full, ordered condition list. Ordering is stable (counts ascending, then
 * delivery, then cache) so plans and reports are reproducible. The order seed
 * shuffles execution order per {@link planPairedMatrix}; this list only fixes
 * the canonical enumeration.
 */
export function buildConditions(): string[] {
  const ids: string[] = [];
  for (const count of SEMA_TAX_PATTERN_COUNTS) {
    if (count === 0) {
      ids.push("p0-baseline");
      continue;
    }
    for (const delivery of SEMA_TAX_DELIVERIES) {
      for (const cache of SEMA_TAX_CACHE_STATES) {
        ids.push(`p${count}-${delivery}-${cache}`);
      }
    }
  }
  return ids;
}

export interface DeliveryPolicy {
  /** What crosses the wire before hydration. */
  onWire:
    | "task-only"
    | "inline-definitions"
    | "opaque-references"
    | "content-references";
  /** Whether the receiver resolves references from the registry. */
  hydratesFromRegistry: boolean;
  /** How the semantic reference is expressed above the resolved block. */
  referenceStyle: "none" | "opaque" | "content";
}

/**
 * Resolves the transport policy for a delivery arm. Prose ships full
 * definitions inline (no hydration); the two resolver arms ship only compact
 * references and hydrate the identical definitions from the registry. The
 * opaque arm controls for compact lookup per ADR 0002; only the content arm's
 * reference is content-derived and can therefore reveal drift.
 */
export function deliveryPolicy(delivery: SemaTaxDelivery): DeliveryPolicy {
  switch (delivery) {
    case "baseline":
      return {
        onWire: "task-only",
        hydratesFromRegistry: false,
        referenceStyle: "none",
      };
    case "prose":
      return {
        onWire: "inline-definitions",
        hydratesFromRegistry: false,
        referenceStyle: "none",
      };
    case "opaque":
      return {
        onWire: "opaque-references",
        hydratesFromRegistry: true,
        referenceStyle: "opaque",
      };
    case "content":
      return {
        onWire: "content-references",
        hydratesFromRegistry: true,
        referenceStyle: "content",
      };
  }
}
