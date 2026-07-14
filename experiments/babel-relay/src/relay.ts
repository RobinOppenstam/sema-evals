import {
  FunctionAgentAdapter,
  referencesMatch,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";
import {
  fingerprint,
  utf8Bytes,
  type ExperimentCondition,
  type MatrixCell,
  type RelayBoundary,
  type RelayScenario,
  type TrialEvent,
  type TrialProvenance,
  type TrialRecord,
} from "@sema-evals/core";

import { CONDITION_POLICIES } from "./conditions.js";

const RELAY = [
  { boundary: "spec-to-plan", sender: "spec-agent", receiver: "planner-agent" },
  {
    boundary: "plan-to-implementation",
    sender: "planner-agent",
    receiver: "implementation-agent",
  },
  {
    boundary: "implementation-to-audit",
    sender: "implementation-agent",
    receiver: "audit-agent",
  },
] as const satisfies ReadonlyArray<{
  boundary: RelayBoundary;
  sender: string;
  receiver: string;
}>;

interface RelayAgentInput {
  agent: string;
  boundary: RelayBoundary;
  definition: Record<string, unknown>;
}

interface RelayAgentOutput {
  acceptedDefinition: Record<string, unknown>;
}

export interface RelayTrialOptions {
  experimentId: string;
  referenceProvider: SemanticReferenceProvider;
  semanticRuntime?: RelaySemanticRuntime;
  provenance: TrialProvenance;
}

export interface RelayHydrationResult {
  definition: Record<string, unknown>;
  observedReference: string;
  workspaceRoot: string;
  resolver: string;
}

export interface RelayHandshakeResult {
  verdict: "PROVIDE_HASH" | "PROCEED" | "HALT";
  observedReference: string;
  workspaceRoot: string;
  reason?: string;
  details: Record<string, unknown>;
}

export interface RelaySemanticRuntime {
  readonly backend: string;
  readonly canonicalVocabularyRoot: string;
  hydrate(
    scenarioId: string,
    handle: string,
    drifted: boolean,
  ): Promise<RelayHydrationResult>;
  handshake(
    scenarioId: string,
    handle: string,
    expectedDigest: string,
    drifted: boolean,
  ): Promise<RelayHandshakeResult>;
  cleanup(): Promise<void>;
}

function wirePayload(
  condition: ExperimentCondition,
  scenario: RelayScenario,
  definition: Record<string, unknown>,
  canonicalReference: string,
): Record<string, unknown> {
  const policy = CONDITION_POLICIES[condition];
  switch (policy.transport) {
    case "task-only":
      return { task: scenario.description };
    case "inline-definition":
      return { handle: scenario.contract.handle, definition };
    case "opaque-reference":
      return { semanticRef: scenario.contract.opaqueRef };
    case "content-reference":
      return { requiredSemanticRef: canonicalReference };
  }
}

export async function runRelayTrial(
  cell: MatrixCell<RelayScenario, ExperimentCondition>,
  options: RelayTrialOptions,
): Promise<TrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const policy = CONDITION_POLICIES[cell.condition];
  const events: TrialEvent[] = [];
  let sequence = 0;
  let currentDefinition = cell.scenario.contract.canonicalDefinition;
  let wireBytes = 0;
  let hydrationBytes = 0;
  let driftInjected = false;
  let driftDetected = false;
  let halted = false;
  let detectionBoundary: RelayBoundary | null = null;

  const canonicalReference = await options.referenceProvider.reference(
    cell.scenario.contract.handle,
    cell.scenario.contract.canonicalDefinition,
  );
  const mutatedReference = await options.referenceProvider.reference(
    cell.scenario.contract.handle,
    cell.scenario.contract.mutatedDefinition,
  );

  const agent = new FunctionAgentAdapter<RelayAgentInput, RelayAgentOutput>(
    {
      id: "deterministic-relay-agent",
      provider: "deterministic",
      model: "relay-v1",
      deterministic: true,
    },
    (input) => ({ acceptedDefinition: input.definition }),
  );

  for (const hop of RELAY) {
    if (cell.scenario.mutation?.boundary === hop.boundary) {
      currentDefinition = cell.scenario.contract.mutatedDefinition;
      driftInjected = true;
      events.push({
        sequence: sequence++,
        type: "mutation",
        boundary: hop.boundary,
        agent: hop.receiver,
        details: {
          fieldPath: cell.scenario.mutation.fieldPath,
          before: cell.scenario.mutation.before,
          after: cell.scenario.mutation.after,
        },
      });
    }

    const payload = wirePayload(
      cell.condition,
      cell.scenario,
      currentDefinition,
      canonicalReference.full,
    );
    const hopWireBytes = utf8Bytes(payload);
    wireBytes += hopWireBytes;
    events.push({
      sequence: sequence++,
      type: "message",
      boundary: hop.boundary,
      agent: hop.sender,
      details: {
        receiver: hop.receiver,
        transport: policy.transport,
        wireBytes: hopWireBytes,
        payload,
      },
    });

    if (policy.hydratesDefinition) {
      const hydration = options.semanticRuntime
        ? await options.semanticRuntime.hydrate(
            cell.scenarioId,
            cell.scenario.contract.handle,
            driftInjected,
          )
        : {
            definition: currentDefinition,
            observedReference: driftInjected
              ? mutatedReference.full
              : canonicalReference.full,
            workspaceRoot: options.provenance.vocabularyRoot,
            resolver:
              policy.transport === "opaque-reference"
                ? "opaque-fixture-resolver"
                : options.referenceProvider.backend,
          };
      if (
        fingerprint(hydration.definition) !== fingerprint(currentDefinition)
      ) {
        throw new Error(
          `${cell.scenarioId}: registry hydration violated information parity.`,
        );
      }
      const hopHydrationBytes = utf8Bytes(hydration.definition);
      hydrationBytes += hopHydrationBytes;
      events.push({
        sequence: sequence++,
        type: "hydration",
        boundary: hop.boundary,
        agent: hop.receiver,
        details: {
          hydrationBytes: hopHydrationBytes,
          resolver: hydration.resolver,
          resolutionExecution: options.semanticRuntime
            ? "prepared-official-workspace-preflight"
            : "in-trial-fixture-resolution",
          observedReference: hydration.observedReference,
          workspaceRoot: hydration.workspaceRoot,
        },
      });
    }

    if (policy.verifiesReference) {
      const handshake = options.semanticRuntime
        ? await options.semanticRuntime.handshake(
            cell.scenarioId,
            cell.scenario.contract.handle,
            canonicalReference.digest,
            driftInjected,
          )
        : undefined;
      if (handshake?.verdict === "PROVIDE_HASH") {
        throw new Error(
          `${cell.scenarioId}: verification runtime did not compare the provided hash.`,
        );
      }
      const observedReference = driftInjected
        ? mutatedReference
        : canonicalReference;
      const matched = handshake
        ? handshake.verdict === "PROCEED"
        : referencesMatch(canonicalReference, observedReference);
      events.push({
        sequence: sequence++,
        type: "verification",
        boundary: hop.boundary,
        agent: hop.receiver,
        details: {
          expected: canonicalReference.full,
          observed: handshake?.observedReference ?? observedReference.full,
          matched,
          enforced: policy.enforcesMismatch,
          verdict: handshake?.verdict ?? (matched ? "PROCEED" : "HALT"),
          verifier:
            options.semanticRuntime?.backend ??
            options.referenceProvider.backend,
          verificationExecution: options.semanticRuntime
            ? "prepared-official-workspace-preflight"
            : "in-trial-reference-comparison",
          workspaceRoot:
            handshake?.workspaceRoot ?? options.provenance.vocabularyRoot,
          ...(handshake?.reason ? { reason: handshake.reason } : {}),
          ...(handshake ? { officialHandshake: handshake.details } : {}),
        },
      });

      if (!matched) {
        driftDetected = true;
        detectionBoundary ??= hop.boundary;
        if (policy.enforcesMismatch) {
          halted = true;
          events.push({
            sequence: sequence++,
            type: "halt",
            boundary: hop.boundary,
            agent: hop.receiver,
            details: { reason: "semantic-reference-mismatch" },
          });
          break;
        }
      }
    }

    const response = await agent.invoke({
      agent: hop.receiver,
      boundary: hop.boundary,
      definition: currentDefinition,
    });
    currentDefinition = response.output.acceptedDefinition;
  }

  const actualAction = halted ? "halt" : "proceed";
  if (!halted) {
    events.push({
      sequence: sequence++,
      type: "completion",
      boundary: null,
      agent: "audit-agent",
      details: { action: actualAction },
    });
  }

  const completedAt = new Date().toISOString();
  const elapsedMs = performance.now() - started;
  const expectedHalt = cell.scenario.expectedAction === "halt";

  return {
    trialId: cell.trialId,
    experimentId: options.experimentId,
    scenarioId: cell.scenarioId,
    condition: cell.condition,
    seed: cell.seed,
    executionIndex: cell.executionIndex,
    startedAt,
    completedAt,
    expectedAction: cell.scenario.expectedAction,
    actualAction,
    events,
    metrics: {
      driftInjected,
      driftDetected,
      halted,
      silentDivergence: driftInjected && !driftDetected,
      correctHalt: halted && expectedHalt,
      falseHalt: halted && !expectedHalt,
      taskSuccess: actualAction === cell.scenario.expectedAction,
      detectionBoundary,
      wireBytes,
      hydrationBytes,
      totalSemanticBytes: wireBytes + hydrationBytes,
      elapsedMs,
    },
    provenance: options.provenance,
    usage: null,
    transcript: null,
  };
}
