import { SECURITY_CONDITIONS, type SecurityCondition } from "./schemas.js";

/**
 * Condition ladder for Phase 4, mirroring ADR 0002's content / addressing /
 * enforcement decomposition (without an opaque-resolver arm — addressing is
 * isolated by equal-prose vs addressed-voluntary):
 *
 * - `baseline`: task-only; no Pattern Cards.
 * - `equal-prose`: identical card content inlined; no content-addressed refs.
 * - `addressed-voluntary`: content-addressed card references via the shared
 *   reference-provider abstraction; auditor MAY cite digests.
 * - `addressed-enforced`: auditor MUST emit a DECISION referencing required
 *   card digests; a deterministic gate refuses findings that do not.
 */
export interface SecurityConditionPolicy {
  deliversCards: boolean;
  onWire: "task-only" | "inline-definitions" | "content-references";
  hydratesFromRegistry: boolean;
  enforcesDecisionRefs: boolean;
}

export const SECURITY_CONDITION_POLICIES: Record<
  SecurityCondition,
  SecurityConditionPolicy
> = {
  baseline: {
    deliversCards: false,
    onWire: "task-only",
    hydratesFromRegistry: false,
    enforcesDecisionRefs: false,
  },
  "equal-prose": {
    deliversCards: true,
    onWire: "inline-definitions",
    hydratesFromRegistry: false,
    enforcesDecisionRefs: false,
  },
  "addressed-voluntary": {
    deliversCards: true,
    onWire: "content-references",
    hydratesFromRegistry: true,
    enforcesDecisionRefs: false,
  },
  "addressed-enforced": {
    deliversCards: true,
    onWire: "content-references",
    hydratesFromRegistry: true,
    enforcesDecisionRefs: true,
  },
};

export function buildConditions(): SecurityCondition[] {
  return [...SECURITY_CONDITIONS];
}

export function conditionPolicy(
  condition: SecurityCondition,
): SecurityConditionPolicy {
  return SECURITY_CONDITION_POLICIES[condition];
}
