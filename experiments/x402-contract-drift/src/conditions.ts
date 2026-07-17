import { X402_DRIFT_CONDITIONS, type X402DriftCondition } from "./schemas.js";

/**
 * The three conditions of the x402 payment-contract drift demo, mirroring the
 * enforcement ladder of Babel Relay / A2A where it maps onto x402:
 *
 * - `baseline`: no semantic extension. Requirements carry term names only; the
 *   payer resolves them against its own (possibly drifted) registry and pays.
 *   Nothing can detect the drift — this is the silent-payment failure mode.
 * - `advertised-voluntary`: the V2 top-level `extensions` map carries
 *   content-addressed references and an acceptance contract; the payer MAY
 *   verify. Here the payer verifies and
 *   surfaces a mismatch, but nothing compels action — payment still emits.
 *   This isolates *voluntary detection*.
 * - `advertised-enforced`: identical wire, but the middleware refuses to emit
 *   the PaymentPayload while any required reference mismatches; typed failure.
 *   This isolates *enforced refusal*.
 *
 * The no-drift controls (scenarios whose `drift` is null) run under all three
 * conditions too, so the false-refusal guard is measured on the same blocks.
 */
export interface X402ConditionPolicy {
  /** PaymentRequired.extensions carries the acceptance contract. */
  advertisesExtension: boolean;
  /** The 402 requirements carry content-addressed references. */
  carriesReferences: boolean;
  /** The payer verifies the acceptance contract against its own registry. */
  verifies: boolean;
  /** The middleware refuses payment on a mismatch (fail-closed). */
  enforces: boolean;
}

export const X402_CONDITION_POLICIES: Record<
  X402DriftCondition,
  X402ConditionPolicy
> = {
  baseline: {
    advertisesExtension: false,
    carriesReferences: false,
    verifies: false,
    enforces: false,
  },
  "advertised-voluntary": {
    advertisesExtension: true,
    carriesReferences: true,
    verifies: true,
    enforces: false,
  },
  "advertised-enforced": {
    advertisesExtension: true,
    carriesReferences: true,
    verifies: true,
    enforces: true,
  },
};

/** The canonical, ordered condition enumeration. `planPairedMatrix` shuffles
 * execution order per the order seed; this only fixes reporting order. */
export function buildConditions(): X402DriftCondition[] {
  return [...X402_DRIFT_CONDITIONS];
}

export function conditionPolicy(
  condition: X402DriftCondition,
): X402ConditionPolicy {
  return X402_CONDITION_POLICIES[condition];
}
