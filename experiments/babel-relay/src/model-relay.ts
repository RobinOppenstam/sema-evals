import {
  referencesMatch,
  type ModelAgentAdapter,
  type ModelCompletion,
  type ModelPromptInput,
  type SemanticReferenceProvider,
  type Transcript,
  type TranscriptEntry,
  type UsageTelemetry,
} from "@sema-evals/adapters";
import {
  fingerprint,
  stableJson,
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
import { RELAY, wirePayload, type RelaySemanticRuntime } from "./relay.js";

/** One model adapter per relay boundary, constructed once per run. */
export type ModelRelayAdapters = Record<
  RelayBoundary,
  ModelAgentAdapter<ModelPromptInput, ModelCompletion>
>;

export interface ModelRelayTrialOptions {
  experimentId: string;
  referenceProvider: SemanticReferenceProvider;
  semanticRuntime?: RelaySemanticRuntime;
  provenance: TrialProvenance;
  adapters: ModelRelayAdapters;
}

/** The strict, machine-parseable audit decision convention. The audit prompt
 * requires a final line of exactly `DECISION: PROCEED` or `DECISION: HALT`. */
const DECISION_LINE = /^DECISION:\s*(PROCEED|HALT)\s*$/;

export type AuditDecision = "proceed" | "halt" | "malformed";

/**
 * Parses the audit model's decision from its final output. The last line that
 * matches the convention wins; anything else is preserved as `malformed`.
 */
export function parseAuditDecision(text: string): AuditDecision {
  let decision: AuditDecision = "malformed";
  for (const line of text.split(/\r?\n/)) {
    const match = DECISION_LINE.exec(line.trim());
    if (match) {
      decision = match[1] === "HALT" ? "halt" : "proceed";
    }
  }
  return decision;
}

/**
 * Canonical, byte-stable pretty rendering of a resolved definition. Keys are
 * sorted so the block is byte-identical regardless of the source (inline prose
 * or registry hydration). Information parity across equal-prose, opaque, and
 * addressed conditions depends on this being deterministic.
 */
export function stableDefinitionText(
  definition: Record<string, unknown>,
): string {
  return JSON.stringify(JSON.parse(stableJson(definition)), null, 2);
}

interface HopMessageParams {
  condition: ExperimentCondition;
  scenario: RelayScenario;
  upstream: string;
  definition: Record<string, unknown>;
  opaqueRef: string;
  contentReference: string;
}

/**
 * Renders the user message for one boundary hop. The resolved-definition block
 * is byte-identical across equal-prose, opaque-resolver, and addressed
 * conditions; only the reference lines above it differ. Baseline receives the
 * task alone. No condition receives reasoning instructions the others lack.
 */
export function buildHopUserMessage(params: HopMessageParams): string {
  const policy = CONDITION_POLICIES[params.condition];
  const sections: string[] = [
    `## Task\n${params.scenario.description}`,
    `## Upstream artifact\n${params.upstream}`,
  ];
  const definitionBlock = `## Resolved definition\n${stableDefinitionText(
    params.definition,
  )}`;

  switch (policy.transport) {
    case "task-only":
      break;
    case "inline-definition":
      sections.push(definitionBlock);
      break;
    case "opaque-reference":
      sections.push(
        `## Semantic reference (opaque lookup)\n${params.opaqueRef}`,
      );
      sections.push(definitionBlock);
      break;
    case "content-reference":
      sections.push(
        `## Semantic reference (content-addressed)\n${params.contentReference}`,
      );
      sections.push(definitionBlock);
      break;
  }

  return sections.join("\n\n");
}

interface ModelHopTelemetry {
  boundary: RelayBoundary;
  status: ModelCompletion["status"];
  stopReason: string | null;
  usage: UsageTelemetry;
}

function emptyUsage(): UsageTelemetry {
  return {
    inputTokens: 0,
    cachedInputTokensRead: 0,
    cachedInputTokensWritten: 0,
    reasoningTokens: null,
    outputTokens: 0,
    attempts: 0,
    retries: 0,
    errors: [],
    latencyMs: 0,
    stopReason: null,
    costUsd: null,
  };
}

/**
 * Aggregates per-hop usage across a trial. Token fields, attempts, retries, and
 * latency sum; errors concatenate; reasoning tokens stay `null` unless a hop
 * reported a number; `stopReason` keeps the terminal hop's value.
 */
export function aggregateUsage(
  hops: readonly UsageTelemetry[],
): UsageTelemetry {
  const total = emptyUsage();
  for (const hop of hops) {
    total.inputTokens += hop.inputTokens;
    total.cachedInputTokensRead += hop.cachedInputTokensRead;
    total.cachedInputTokensWritten += hop.cachedInputTokensWritten;
    total.outputTokens += hop.outputTokens;
    total.attempts += hop.attempts;
    total.retries += hop.retries;
    total.latencyMs += hop.latencyMs;
    total.errors.push(...hop.errors);
    if (hop.reasoningTokens !== null) {
      total.reasoningTokens =
        (total.reasoningTokens ?? 0) + hop.reasoningTokens;
    }
    total.stopReason = hop.stopReason;
    if (hop.costUsd !== null) {
      total.costUsd = (total.costUsd ?? 0) + hop.costUsd;
    }
  }
  return total;
}

/**
 * Concatenates per-hop transcripts into one trial transcript with globally
 * sequential indices. Each hop's leading `system` entry carries its frozen
 * boundary prompt, so boundaries remain identifiable without a schema change;
 * every entry additionally records its boundary in `raw`.
 */
function concatenateTranscripts(
  hops: readonly { boundary: RelayBoundary; transcript: Transcript }[],
): Transcript {
  const entries: TranscriptEntry[] = [];
  let index = 0;
  for (const hop of hops) {
    for (const entry of hop.transcript.entries) {
      entries.push({
        ...entry,
        index: index++,
        raw: { boundary: hop.boundary, entry: entry.raw },
      });
    }
  }
  return { entries };
}

export async function runModelRelayTrial(
  cell: MatrixCell<RelayScenario, ExperimentCondition>,
  options: ModelRelayTrialOptions,
): Promise<TrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const policy = CONDITION_POLICIES[cell.condition];
  const events: TrialEvent[] = [];
  const hopUsages: UsageTelemetry[] = [];
  const modelHops: ModelHopTelemetry[] = [];
  const hopTranscripts: { boundary: RelayBoundary; transcript: Transcript }[] =
    [];
  let sequence = 0;
  let currentDefinition = cell.scenario.contract.canonicalDefinition;
  let upstream = cell.scenario.description;
  let wireBytes = 0;
  let hydrationBytes = 0;
  let driftInjected = false;
  let referenceDetected = false;
  let enforcementHalted = false;
  let hopFailed = false;
  let detectionBoundary: RelayBoundary | null = null;
  let auditDecision: AuditDecision | null = null;

  const canonicalReference = await options.referenceProvider.reference(
    cell.scenario.contract.handle,
    cell.scenario.contract.canonicalDefinition,
  );
  const mutatedReference = await options.referenceProvider.reference(
    cell.scenario.contract.handle,
    cell.scenario.contract.mutatedDefinition,
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

    // Objective content-addressing check. The model never recomputes a hash;
    // the harness compares references, exactly as in the deterministic relay.
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
        referenceDetected = true;
        detectionBoundary ??= hop.boundary;
        if (policy.enforcesMismatch) {
          enforcementHalted = true;
          events.push({
            sequence: sequence++,
            type: "halt",
            boundary: hop.boundary,
            agent: hop.receiver,
            details: { reason: "semantic-reference-mismatch", modelHops },
          });
          break;
        }
      }
    }

    const userMessage = buildHopUserMessage({
      condition: cell.condition,
      scenario: cell.scenario,
      upstream,
      definition: currentDefinition,
      opaqueRef: cell.scenario.contract.opaqueRef,
      contentReference: canonicalReference.full,
    });

    const response = await options.adapters[hop.boundary].invoke({
      messages: [{ role: "user", content: userMessage }],
    });
    hopUsages.push(response.usage);
    hopTranscripts.push({
      boundary: hop.boundary,
      transcript: response.transcript,
    });
    modelHops.push({
      boundary: hop.boundary,
      status: response.output.status,
      stopReason: response.output.stopReason,
      usage: response.usage,
    });

    if (response.output.status !== "completed") {
      hopFailed = true;
      break;
    }

    if (hop.boundary === "implementation-to-audit") {
      auditDecision = parseAuditDecision(response.output.text);
    }

    upstream = response.output.text;
  }

  const auditMalformed = auditDecision === "malformed";
  const auditHalt = auditDecision === "halt";
  const halted = enforcementHalted || auditHalt;
  const actualAction = halted ? "halt" : "proceed";
  const driftDetected = referenceDetected || auditHalt;
  const expectedHalt = cell.scenario.expectedAction === "halt";
  const taskSuccess =
    !hopFailed &&
    !auditMalformed &&
    actualAction === cell.scenario.expectedAction;

  if (!enforcementHalted) {
    events.push({
      sequence: sequence++,
      type: "completion",
      boundary: null,
      agent: "audit-agent",
      details: {
        action: actualAction,
        auditDecision: auditDecision ?? "not-reached",
        auditMalformed,
        hopFailed,
        modelHops,
      },
    });
  }

  const completedAt = new Date().toISOString();
  const elapsedMs = performance.now() - started;

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
      taskSuccess,
      detectionBoundary,
      wireBytes,
      hydrationBytes,
      totalSemanticBytes: wireBytes + hydrationBytes,
      elapsedMs,
    },
    provenance: options.provenance,
    usage: aggregateUsage(hopUsages),
    transcript: concatenateTranscripts(hopTranscripts),
  };
}
