import { type SemanticReferenceProvider } from "@sema-evals/adapters";
import {
  type MatrixCell,
  type TrialEvent,
  type TrialProvenance,
} from "@sema-evals/core";

import {
  buildPaymentPayload,
  buildPaymentRequirements,
  buildPaymentRequirementsResponse,
  buildRequiredReferences,
  buildSettlementResponse,
  extractAcceptanceContract,
  hydrationBytesFor,
} from "./agents.js";
import { conditionPolicy } from "./conditions.js";
import {
  applyEnforcement,
  verifyAcceptanceContract,
  type VerificationResult,
} from "./middleware.js";
import {
  assertDriftIsolation,
  buildPayerRegistry,
  buildSellerRegistry,
} from "./registry.js";
import {
  x402DriftTrialRecordSchema,
  type PaymentPayload,
  type PaymentState,
  type SemanticReference,
  type SettlementResponse,
  type X402DriftCondition,
  type X402DriftMetrics,
  type X402DriftScenario,
  type X402DriftTrialRecord,
} from "./schemas.js";
import { InProcessX402Transport } from "./transport.js";

const SELLER = "sema-seller-agent";
const PAYER = "sema-payer-agent";

export interface X402DriftTrialOptions {
  experimentId: string;
  referenceProvider: SemanticReferenceProvider;
  vocabularyRoot: string;
  provenance: TrialProvenance;
}

/** Empty verification result for conditions where the payer does not verify. */
const NO_VERIFICATION: VerificationResult = {
  checks: [],
  referencesChecked: 0,
  referencesMatched: 0,
  referencesMismatched: 0,
  driftDetected: false,
};

/**
 * Runs one deterministic x402 drift trial: a seller and a payer exchange an
 * x402-shaped 402 requirements response and optional PaymentPayload through an
 * in-process transport, each resolving handles against its OWN registry, with
 * controlled cross-party registry drift injected into the payer's registry. The
 * scripted agents exercise every path — silent payment under baseline,
 * voluntary detection, enforced refusal, and the no-drift false-refusal guard
 * — with no model call and exact, test-checked metrics. `usage` and
 * `transcript` are null, as in the deterministic siblings.
 */
export async function runX402DriftTrial(
  cell: MatrixCell<X402DriftScenario, X402DriftCondition>,
  options: X402DriftTrialOptions,
): Promise<X402DriftTrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const scenario = cell.scenario;
  const condition = cell.condition;
  const policy = conditionPolicy(condition);
  const driftInjected = scenario.drift !== null;

  assertDriftIsolation(scenario);

  const sellerRegistry = buildSellerRegistry(scenario);
  const payerRegistry = buildPayerRegistry(scenario);

  let references: SemanticReference[] | undefined;
  if (policy.carriesReferences) {
    references = await buildRequiredReferences(
      scenario,
      sellerRegistry,
      options.referenceProvider,
    );
  }

  const { requirements } = buildPaymentRequirements(
    scenario,
    condition,
    references,
  );
  const response = buildPaymentRequirementsResponse(requirements);
  const transport = new InProcessX402Transport();
  const delivered = transport.deliverRequirements(response);
  const hydrationBytes = hydrationBytesFor(scenario, payerRegistry);

  const events: TrialEvent[] = [];
  let sequence = 0;

  events.push({
    sequence: sequence++,
    type: "message",
    boundary: null,
    agent: SELLER,
    details: {
      receiver: PAYER,
      transport: delivered.transport,
      condition,
      extensionAdvertised: policy.advertisesExtension,
      carriesReferences: policy.carriesReferences,
      wireBytes: delivered.wireBytes,
      requestedHandles: scenario.acceptanceHandles,
      status: 402,
    },
  });

  if (scenario.drift) {
    events.push({
      sequence: sequence++,
      type: "mutation",
      boundary: null,
      agent: PAYER,
      details: {
        handle: scenario.drift.handle,
        fieldPath: scenario.drift.fieldPath,
        before: scenario.drift.before,
        after: scenario.drift.after,
        registry: "payer",
      },
    });
  }

  events.push({
    sequence: sequence++,
    type: "hydration",
    boundary: null,
    agent: PAYER,
    details: {
      hydrationBytes,
      resolver: options.referenceProvider.backend,
      handles: scenario.acceptanceHandles,
      registry: "payer",
    },
  });

  let finalPaymentState: PaymentState = "paid";
  let halted = false;
  let paid = true;
  let failureReason: string | null = null;
  let verification = NO_VERIFICATION;
  let paymentPayload: PaymentPayload | null = null;
  let settlement: SettlementResponse | null = null;

  const accepted = delivered.response.accepts[0];
  if (!accepted) {
    throw new Error(
      "402 response must carry at least one PaymentRequirements.",
    );
  }
  const contract = extractAcceptanceContract(accepted);

  if (policy.verifies && contract) {
    verification = await verifyAcceptanceContract(
      contract,
      payerRegistry,
      options.referenceProvider,
    );
    const decision = applyEnforcement(verification, contract.enforcement);
    finalPaymentState = decision.terminalState;
    halted = decision.halted;
    paid = decision.paid;
    failureReason = decision.failureReason;

    events.push({
      sequence: sequence++,
      type: "verification",
      boundary: null,
      agent: PAYER,
      details: {
        enforced: policy.enforces,
        referencesChecked: verification.referencesChecked,
        referencesMatched: verification.referencesMatched,
        referencesMismatched: verification.referencesMismatched,
        driftDetected: verification.driftDetected,
        verdict: decision.halted ? "REFUSE" : "PAY",
        checks: verification.checks,
        verifier: options.referenceProvider.backend,
      },
    });
  } else {
    // Baseline (or extension-not-carried): no verification is possible, so the
    // payer pays using whatever its registry holds.
    finalPaymentState = "paid";
    paid = true;
    halted = false;
  }

  const driftDetected = verification.driftDetected;
  let paymentWireBytes = 0;
  let settlementWireBytes = 0;

  if (paid) {
    paymentPayload = buildPaymentPayload(accepted, scenario);
    const paymentDelivery = transport.deliverPayment(paymentPayload);
    paymentWireBytes = paymentDelivery.wireBytes;
    settlement = buildSettlementResponse(accepted, paymentPayload);
    const settlementDelivery = transport.deliverSettlement(settlement);
    settlementWireBytes = settlementDelivery.wireBytes;

    events.push({
      sequence: sequence++,
      type: "completion",
      boundary: null,
      agent: PAYER,
      details: {
        finalPaymentState,
        driftDetected,
        paymentWireBytes,
        note: driftDetected
          ? "voluntary detection: mismatch surfaced but payment not blocked"
          : "payment emitted",
      },
    });
  } else {
    events.push({
      sequence: sequence++,
      type: "halt",
      boundary: null,
      agent: PAYER,
      details: { reason: failureReason, finalPaymentState },
    });
  }

  // The safety-correct terminal state is `refused` for a drift scenario
  // (payment under a misunderstood contract must not ship) and `paid` for a
  // no-drift control.
  const safetyCorrectTerminal: PaymentState = driftInjected
    ? "refused"
    : "paid";
  const silentPayment = driftInjected && paid && !driftDetected;
  const totalWireBytes =
    delivered.wireBytes + paymentWireBytes + settlementWireBytes;

  const metrics: X402DriftMetrics = {
    driftInjected,
    extensionAdvertised: policy.advertisesExtension,
    referencesCarried: policy.carriesReferences,
    verificationPerformed: policy.verifies && contract !== undefined,
    referencesChecked: verification.referencesChecked,
    referencesMatched: verification.referencesMatched,
    referencesMismatched: verification.referencesMismatched,
    driftDetected,
    paid,
    halted,
    silentPayment,
    correctHalt: halted && driftInjected,
    falseHalt: halted && !driftInjected,
    taskSuccess: finalPaymentState === safetyCorrectTerminal,
    finalPaymentState,
    failureReason,
    wireBytes: totalWireBytes,
    hydrationBytes,
    totalSemanticBytes: totalWireBytes + hydrationBytes,
    elapsedMs: performance.now() - started,
  };

  const record: X402DriftTrialRecord = {
    trialId: cell.trialId,
    experimentId: options.experimentId,
    scenarioId: cell.scenarioId,
    condition,
    seed: cell.seed,
    executionIndex: cell.executionIndex,
    startedAt,
    completedAt: new Date().toISOString(),
    driftInjected,
    finalPaymentState,
    paymentRequirements: accepted,
    paymentPayload,
    settlement,
    events,
    metrics,
    provenance: options.provenance,
    usage: null,
    transcript: null,
  };

  return x402DriftTrialRecordSchema.parse(record);
}
