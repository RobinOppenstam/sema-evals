import {
  referencesMatch,
  type SemanticReference as ProviderReference,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";

import type { AgentRegistry } from "./registry.js";
import type {
  AcceptanceContract,
  SemanticReference,
  TaskState,
} from "./schemas.js";

/**
 * The Sema A2A semantic-extension MIDDLEWARE.
 *
 * This is the extension-compatible prototype Phase 3 asks for. It is kept
 * deliberately separable from the demo harness (the transport and scripted
 * agents): it is a pure function of an acceptance contract and a resolving
 * registry, so it can later be dropped into a real A2A worker without change.
 *
 * It does two things and nothing else:
 *
 * 1. VERIFY — recompute each required reference from the worker's OWN registry
 *    definition through the same canonicalization pathway the requester used,
 *    and compare it against the contract's required reference.
 * 2. ENFORCE — decide the task's terminal transition. Under `enforced`, any
 *    mismatch blocks `completed` and yields `failed` with a typed reason. Under
 *    `voluntary`, the verdict is advisory: the task still completes even when a
 *    mismatch is found (detection without compulsion).
 */

/** The typed failure reason emitted when enforcement blocks completion. */
export const SEMANTIC_MISMATCH_REASON = "semantic-reference-mismatch";

export interface ReferenceCheck {
  handle: string;
  expectedRef: string;
  observedRef: string;
  matched: boolean;
}

export interface VerificationResult {
  checks: ReferenceCheck[];
  referencesChecked: number;
  referencesMatched: number;
  referencesMismatched: number;
  driftDetected: boolean;
}

function toProviderReference(reference: SemanticReference): ProviderReference {
  return {
    handle: reference.handle,
    display: `${reference.handle}#${reference.digest.slice(0, 4)}`,
    full: reference.ref,
    digest: reference.digest,
    backend: reference.canonicalizationVersion,
    officialSema: false,
  };
}

/**
 * Verifies an acceptance contract against a resolving registry. For each
 * required reference, the worker recomputes the reference from its own
 * definition and compares. A mismatch on any handle means the worker's registry
 * has drifted from what the requester addressed.
 */
export async function verifyAcceptanceContract(
  contract: AcceptanceContract,
  workerRegistry: AgentRegistry,
  referenceProvider: SemanticReferenceProvider,
): Promise<VerificationResult> {
  const checks: ReferenceCheck[] = [];
  for (const required of contract.requiredReferences) {
    const workerDefinition = workerRegistry.resolve(required.handle);
    const observed = await referenceProvider.reference(
      required.handle,
      workerDefinition,
    );
    const matched = referencesMatch(toProviderReference(required), observed);
    checks.push({
      handle: required.handle,
      expectedRef: required.ref,
      observedRef: observed.full,
      matched,
    });
  }
  const referencesMatched = checks.filter((check) => check.matched).length;
  const referencesMismatched = checks.length - referencesMatched;
  return {
    checks,
    referencesChecked: checks.length,
    referencesMatched,
    referencesMismatched,
    driftDetected: referencesMismatched > 0,
  };
}

export interface EnforcementDecision {
  terminalState: Extract<TaskState, "completed" | "failed">;
  halted: boolean;
  failureReason: string | null;
}

/**
 * The enforcement transition rule. Given a verification result and the
 * contract's enforcement mode, decide the task's terminal state:
 *
 * - `enforced` + any mismatch  -> `failed` (halted, typed reason)
 * - `enforced` + all match      -> `completed`
 * - `voluntary` (any result)    -> `completed` (verdict is advisory)
 *
 * A no-drift trial verifies clean, so an `enforced` worker completes it: the
 * rule cannot manufacture a false halt. This is the false-halt guard.
 */
export function applyEnforcement(
  verification: VerificationResult,
  enforcement: AcceptanceContract["enforcement"],
): EnforcementDecision {
  if (enforcement === "enforced" && verification.driftDetected) {
    return {
      terminalState: "failed",
      halted: true,
      failureReason: SEMANTIC_MISMATCH_REASON,
    };
  }
  return { terminalState: "completed", halted: false, failureReason: null };
}
