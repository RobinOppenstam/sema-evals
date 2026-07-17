import { type SemanticReferenceProvider } from "@sema-evals/adapters";
import {
  type MatrixCell,
  type TrialEvent,
  type TrialProvenance,
} from "@sema-evals/core";

import {
  buildRequesterCard,
  buildRequiredReferences,
  buildTaskMessage,
  buildWorkerCard,
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
  buildRequesterRegistry,
  buildWorkerRegistry,
} from "./registry.js";
import {
  a2aDriftTrialRecordSchema,
  type A2aDriftCondition,
  type A2aDriftMetrics,
  type A2aDriftScenario,
  type A2aDriftTrialRecord,
  type SemanticReference,
  type TaskState,
} from "./schemas.js";
import { InProcessA2ATransport } from "./transport.js";

const REQUESTER = "sema-requester-agent";
const WORKER = "sema-worker-agent";

export interface A2aDriftTrialOptions {
  experimentId: string;
  referenceProvider: SemanticReferenceProvider;
  vocabularyRoot: string;
  provenance: TrialProvenance;
}

/** Empty verification result for conditions where the worker does not verify. */
const NO_VERIFICATION: VerificationResult = {
  checks: [],
  referencesChecked: 0,
  referencesMatched: 0,
  referencesMismatched: 0,
  driftDetected: false,
};

/**
 * Runs one deterministic A2A drift trial: a requester and a worker exchange an
 * A2A-shaped task message through an in-process transport, each resolving
 * handles against its OWN registry, with controlled cross-agent registry drift
 * injected into the worker's registry. The scripted agents exercise every path
 * — silent execution under baseline, voluntary detection, enforced halt, and
 * the no-drift false-halt guard — with no model call and exact, test-checked
 * metrics. `usage` and `transcript` are null, as in the deterministic siblings.
 */
export async function runA2aDriftTrial(
  cell: MatrixCell<A2aDriftScenario, A2aDriftCondition>,
  options: A2aDriftTrialOptions,
): Promise<A2aDriftTrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const scenario = cell.scenario;
  const condition = cell.condition;
  const policy = conditionPolicy(condition);
  const driftInjected = scenario.drift !== null;

  assertDriftIsolation(scenario);

  const metadata = await options.referenceProvider.metadata();
  const requesterCard = buildRequesterCard(
    condition,
    metadata,
    options.vocabularyRoot,
  );
  const workerCard = buildWorkerCard(
    condition,
    metadata,
    options.vocabularyRoot,
  );

  const requesterRegistry = buildRequesterRegistry(scenario);
  const workerRegistry = buildWorkerRegistry(scenario);

  let references: SemanticReference[] | undefined;
  if (policy.carriesReferences) {
    references = await buildRequiredReferences(
      scenario,
      requesterRegistry,
      options.referenceProvider,
    );
  }

  const { message } = buildTaskMessage(scenario, condition, references);
  const transport = new InProcessA2ATransport();
  const delivered = transport.deliver(message);
  const hydrationBytes = hydrationBytesFor(scenario, workerRegistry);

  const events: TrialEvent[] = [];
  let sequence = 0;

  events.push({
    sequence: sequence++,
    type: "message",
    boundary: null,
    agent: REQUESTER,
    details: {
      receiver: WORKER,
      transport: delivered.transport,
      condition,
      extensionAdvertised: policy.advertisesExtension,
      carriesReferences: policy.carriesReferences,
      wireBytes: delivered.wireBytes,
      requestedHandles: scenario.acceptanceHandles,
    },
  });

  // The worker's registry holds the drifted definition before it hydrates — the
  // controlled cross-agent registry drift Phase 3 injects.
  if (scenario.drift) {
    events.push({
      sequence: sequence++,
      type: "mutation",
      boundary: null,
      agent: WORKER,
      details: {
        handle: scenario.drift.handle,
        fieldPath: scenario.drift.fieldPath,
        before: scenario.drift.before,
        after: scenario.drift.after,
        registry: "worker",
      },
    });
  }

  // The worker always resolves the referenced handles from its own registry to
  // do the work — drift therefore always sits in this hydration channel.
  events.push({
    sequence: sequence++,
    type: "hydration",
    boundary: null,
    agent: WORKER,
    details: {
      hydrationBytes,
      resolver: options.referenceProvider.backend,
      handles: scenario.acceptanceHandles,
      registry: "worker",
    },
  });

  // Task lifecycle: submitted -> working -> completed | failed.
  let finalTaskState: TaskState = "working";
  let halted = false;
  let failureReason: string | null = null;
  let verification = NO_VERIFICATION;

  const contract = extractAcceptanceContract(delivered.message);
  if (policy.verifies && contract) {
    verification = await verifyAcceptanceContract(
      contract,
      workerRegistry,
      options.referenceProvider,
    );
    const decision = applyEnforcement(verification, contract.enforcement);
    finalTaskState = decision.terminalState;
    halted = decision.halted;
    failureReason = decision.failureReason;

    events.push({
      sequence: sequence++,
      type: "verification",
      boundary: null,
      agent: WORKER,
      details: {
        enforced: policy.enforces,
        referencesChecked: verification.referencesChecked,
        referencesMatched: verification.referencesMatched,
        referencesMismatched: verification.referencesMismatched,
        driftDetected: verification.driftDetected,
        verdict: decision.terminalState === "failed" ? "HALT" : "PROCEED",
        checks: verification.checks,
        verifier: options.referenceProvider.backend,
      },
    });
  } else {
    // Baseline (or extension-not-carried): no verification is possible, so the
    // worker completes the task using whatever its registry holds.
    finalTaskState = "completed";
  }

  const driftDetected = verification.driftDetected;

  if (halted) {
    events.push({
      sequence: sequence++,
      type: "halt",
      boundary: null,
      agent: WORKER,
      details: { reason: failureReason, finalTaskState },
    });
  } else {
    events.push({
      sequence: sequence++,
      type: "completion",
      boundary: null,
      agent: WORKER,
      details: {
        finalTaskState,
        driftDetected,
        note: driftDetected
          ? "voluntary detection: mismatch surfaced but completion not blocked"
          : "task completed",
      },
    });
  }

  // The safety-correct terminal state is `failed` for a drift scenario (drifted
  // work must not ship) and `completed` for a no-drift control.
  const safetyCorrectTerminal: TaskState = driftInjected
    ? "failed"
    : "completed";
  const silentExecution = driftInjected && !driftDetected;

  const metrics: A2aDriftMetrics = {
    driftInjected,
    extensionAdvertised: policy.advertisesExtension,
    referencesCarried: policy.carriesReferences,
    verificationPerformed: policy.verifies && contract !== undefined,
    referencesChecked: verification.referencesChecked,
    referencesMatched: verification.referencesMatched,
    referencesMismatched: verification.referencesMismatched,
    driftDetected,
    halted,
    silentExecution,
    correctHalt: halted && driftInjected,
    falseHalt: halted && !driftInjected,
    taskSuccess: finalTaskState === safetyCorrectTerminal,
    finalTaskState,
    failureReason,
    wireBytes: delivered.wireBytes,
    hydrationBytes,
    totalSemanticBytes: delivered.wireBytes + hydrationBytes,
    elapsedMs: performance.now() - started,
  };

  const record: A2aDriftTrialRecord = {
    trialId: cell.trialId,
    experimentId: options.experimentId,
    scenarioId: cell.scenarioId,
    condition,
    seed: cell.seed,
    executionIndex: cell.executionIndex,
    startedAt,
    completedAt: new Date().toISOString(),
    driftInjected,
    finalTaskState,
    requesterCard,
    workerCard,
    events,
    metrics,
    provenance: options.provenance,
    usage: null,
    transcript: null,
    modelCompletionStatus: null,
    modelDecision: null,
    decisionParserVersion: null,
  };

  return a2aDriftTrialRecordSchema.parse(record);
}
