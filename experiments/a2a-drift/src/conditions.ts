import { A2A_DRIFT_CONDITIONS, type A2aDriftCondition } from "./schemas.js";

/**
 * The three conditions of the A2A semantic-extension demo, mirroring the
 * enforcement ladder of Babel Relay (ADR 0002) where it maps onto A2A:
 *
 * - `baseline`: no semantic extension. Task messages carry handle names only;
 *   the worker resolves them against its own (possibly drifted) registry and
 *   completes. Nothing can detect the drift — this is the silent-execution
 *   failure mode Phase 3 exists to surface.
 * - `advertised-voluntary`: both Agent Cards advertise the extension; the task
 *   message carries content-addressed references and an acceptance contract;
 *   the worker MAY verify. Here the worker verifies and surfaces a mismatch,
 *   but nothing compels action — the task still completes. This isolates
 *   *voluntary detection*.
 * - `advertised-enforced`: identical wire, but the middleware refuses to
 *   transition the task to `completed` while any required reference mismatches;
 *   the task fails with a typed reason. This isolates *enforced halt*.
 *
 * The no-drift controls (scenarios whose `drift` is null) run under all three
 * conditions too, so the false-halt guard is measured on the same blocks.
 */
export interface A2aConditionPolicy {
  /** Both Agent Cards advertise the semantic extension. */
  advertisesExtension: boolean;
  /** The task message carries content-addressed references + acceptance
   * contract (baseline carries handle names only). */
  carriesReferences: boolean;
  /** The worker verifies the acceptance contract against its own registry. */
  verifies: boolean;
  /** The middleware blocks completion on a mismatch (fail-closed). */
  enforces: boolean;
}

export const A2A_CONDITION_POLICIES: Record<
  A2aDriftCondition,
  A2aConditionPolicy
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
export function buildConditions(): A2aDriftCondition[] {
  return [...A2A_DRIFT_CONDITIONS];
}

export function conditionPolicy(
  condition: A2aDriftCondition,
): A2aConditionPolicy {
  return A2A_CONDITION_POLICIES[condition];
}
