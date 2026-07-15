import { deliveryPolicy, type DeliveryPolicy } from "../conditions.js";
import {
  SEMA_TAX_REUSE_FACTORS,
  SEMA_TAX_SIZE_REUSE_DELIVERIES,
  SEMA_TAX_SIZE_REUSE_PATTERN_COUNT,
  SEMA_TAX_SIZE_TIERS,
  type SemaTaxSizeReuseDelivery,
  type SemaTaxSizeTier,
} from "./schemas.js";

export interface SizeReuseConditionParts {
  patternCount: number;
  size: SemaTaxSizeTier;
  reuse: number;
  delivery: SemaTaxSizeReuseDelivery;
}

const CONDITION_PATTERN =
  /^p(\d+)-(small|medium|large)-r(\d+)-(prose|opaque|content)-cold$/;

/** Builds the canonical size/reuse condition id. Cache is always cold in this
 * arm, so it is a fixed suffix rather than a factor. */
export function sizeReuseConditionId(parts: SizeReuseConditionParts): string {
  return `p${parts.patternCount}-${parts.size}-r${parts.reuse}-${parts.delivery}-cold`;
}

/** Parses a size/reuse condition id, throwing on a malformed id so a typo can
 * never silently create a phantom condition. */
export function parseSizeReuseCondition(id: string): SizeReuseConditionParts {
  const match = CONDITION_PATTERN.exec(id);
  if (!match) {
    throw new Error(`Malformed sema-tax size/reuse condition id: ${id}`);
  }
  return {
    patternCount: Number(match[1]),
    size: match[2] as SemaTaxSizeTier,
    reuse: Number(match[3]),
    delivery: match[4] as SemaTaxSizeReuseDelivery,
  };
}

/**
 * The full, ordered condition list for the size/reuse arm: 3 sizes x 3 reuse
 * factors x 3 deliveries = 27, at the fixed p8 cold pattern count. Ordering is
 * stable (size, then reuse, then delivery) so plans and reports are
 * reproducible; execution order is shuffled per the recorded order seed.
 */
export function buildSizeReuseConditions(): string[] {
  const ids: string[] = [];
  for (const size of SEMA_TAX_SIZE_TIERS) {
    for (const reuse of SEMA_TAX_REUSE_FACTORS) {
      for (const delivery of SEMA_TAX_SIZE_REUSE_DELIVERIES) {
        ids.push(
          sizeReuseConditionId({
            patternCount: SEMA_TAX_SIZE_REUSE_PATTERN_COUNT,
            size,
            reuse,
            delivery,
          }),
        );
      }
    }
  }
  return ids;
}

/** Resolves the transport policy for a size/reuse delivery arm. Delegates to the
 * base delivery policy — the three arms behave identically to the base design;
 * this arm only adds size and reuse on top. */
export function sizeReuseDeliveryPolicy(
  delivery: SemaTaxSizeReuseDelivery,
): DeliveryPolicy {
  return deliveryPolicy(delivery);
}
