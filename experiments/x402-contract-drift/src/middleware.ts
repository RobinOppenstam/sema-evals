import {
  referencesMatch,
  type SemanticReference as ProviderReference,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";

import type { PartyRegistry } from "./registry.js";
import type {
  AcceptanceContract,
  PaymentState,
  SemanticReference,
} from "./schemas.js";

/**
 * The Sema x402 payment-contract MIDDLEWARE.
 *
 * Kept deliberately separable from the demo harness (transport and scripted
 * agents): it is a pure function of an acceptance contract and a resolving
 * registry, so it can later be dropped into a real x402 payer client without
 * change.
 *
 * It does two things and nothing else:
 *
 * 1. VERIFY — recompute each required reference from the payer's OWN registry
 *    definition through the same canonicalization pathway the seller used, and
 *    compare it against the contract's required reference.
 * 2. ENFORCE — decide whether to emit a PaymentPayload. Under `enforced`, any
 *    mismatch refuses payment with a typed reason. Under `voluntary`, the
 *    verdict is advisory: the payer still pays even when a mismatch is found.
 */

/** The typed failure reason emitted when enforcement refuses payment. */
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
 * required reference, the payer recomputes the reference from its own
 * definition and compares. A mismatch on any handle means the payer's registry
 * has drifted from what the seller addressed.
 */
export async function verifyAcceptanceContract(
  contract: AcceptanceContract,
  payerRegistry: PartyRegistry,
  referenceProvider: SemanticReferenceProvider,
): Promise<VerificationResult> {
  const checks: ReferenceCheck[] = [];
  for (const required of contract.requiredReferences) {
    const payerDefinition = payerRegistry.resolve(required.handle);
    const observed = await referenceProvider.reference(
      required.handle,
      payerDefinition,
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
  terminalState: PaymentState;
  halted: boolean;
  paid: boolean;
  failureReason: string | null;
}

/**
 * The enforcement transition rule. Given a verification result and the
 * contract's enforcement mode, decide whether to emit a PaymentPayload:
 *
 * - `enforced` + any mismatch  -> `refused` (halted, typed reason)
 * - `enforced` + all match      -> `paid`
 * - `voluntary` (any result)    -> `paid` (verdict is advisory)
 *
 * A no-drift trial verifies clean, so an `enforced` payer pays it: the rule
 * cannot manufacture a false refusal. This is the false-refusal guard.
 */
export function applyEnforcement(
  verification: VerificationResult,
  enforcement: AcceptanceContract["enforcement"],
): EnforcementDecision {
  if (enforcement === "enforced" && verification.driftDetected) {
    return {
      terminalState: "refused",
      halted: true,
      paid: false,
      failureReason: SEMANTIC_MISMATCH_REASON,
    };
  }
  return {
    terminalState: "paid",
    halted: false,
    paid: true,
    failureReason: null,
  };
}
