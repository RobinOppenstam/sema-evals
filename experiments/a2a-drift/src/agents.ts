import {
  type SemanticBackendMetadata,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";
import { fingerprint, utf8Bytes } from "@sema-evals/core";

import { conditionPolicy } from "./conditions.js";
import type { AgentRegistry } from "./registry.js";
import {
  A2A_PROTOCOL_VERSION,
  SEMANTIC_EXTENSION_URI,
  type A2aDriftCondition,
  type A2aDriftScenario,
  type A2aMessage,
  type AcceptanceContract,
  type AgentCard,
  type DataPart,
  type Part,
  type SemanticReference,
} from "./schemas.js";

/** The extension enforcement mode a condition advertises on its Agent Cards. */
function advertisedEnforcement(
  condition: A2aDriftCondition,
): "voluntary" | "enforced" {
  return condition === "advertised-enforced" ? "enforced" : "voluntary";
}

/**
 * Builds an A2A Agent Card. When `metadata` is supplied (the extension is
 * advertised), the card lists the Sema semantic extension under
 * `capabilities.extensions` with the canonicalization version and vocabulary
 * root in its params — exactly the advertisement Phase 3 requires. Baseline
 * cards omit the extension entirely.
 */
export function buildAgentCard(options: {
  name: string;
  description: string;
  url: string;
  skillId: string;
  skillName: string;
  skillDescription: string;
  extension:
    | {
        metadata: SemanticBackendMetadata;
        vocabularyRoot: string;
        enforcement: "voluntary" | "enforced";
        required: boolean;
      }
    | undefined;
}): AgentCard {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: options.name,
    description: options.description,
    url: options.url,
    version: "0.1.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: options.extension
        ? [
            {
              uri: SEMANTIC_EXTENSION_URI,
              description:
                "Content-addressed semantic canonicalization: task acceptance is bound to vocabulary references.",
              required: options.extension.required,
              params: {
                canonicalizationVersion:
                  options.extension.metadata.canonicalizationVersion,
                vocabularyRoot: options.extension.vocabularyRoot,
                backend: options.extension.metadata.backend,
                enforcement: options.extension.enforcement,
              },
            },
          ]
        : [],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: options.skillId,
        name: options.skillName,
        description: options.skillDescription,
      },
    ],
  };
}

export function buildRequesterCard(
  condition: A2aDriftCondition,
  metadata: SemanticBackendMetadata,
  vocabularyRoot: string,
): AgentCard {
  const policy = conditionPolicy(condition);
  return buildAgentCard({
    name: "sema-requester-agent",
    description: "Issues acceptance-contracted tasks over A2A.",
    url: "inproc://requester",
    skillId: "issue-task",
    skillName: "Issue task",
    skillDescription: "Delegate a task with a semantic acceptance contract.",
    extension: policy.advertisesExtension
      ? {
          metadata,
          vocabularyRoot,
          enforcement: advertisedEnforcement(condition),
          required: false,
        }
      : undefined,
  });
}

export function buildWorkerCard(
  condition: A2aDriftCondition,
  metadata: SemanticBackendMetadata,
  vocabularyRoot: string,
): AgentCard {
  const policy = conditionPolicy(condition);
  return buildAgentCard({
    name: "sema-worker-agent",
    description: "Executes tasks against its own semantic registry.",
    url: "inproc://worker",
    skillId: "execute-task",
    skillName: "Execute task",
    skillDescription: "Resolve referenced patterns and complete the task.",
    extension: policy.advertisesExtension
      ? {
          metadata,
          vocabularyRoot,
          // The worker's card advertises whether its middleware enforces.
          enforcement: advertisedEnforcement(condition),
          required: condition === "advertised-enforced",
        }
      : undefined,
  });
}

/**
 * Resolves each acceptance handle from the requester's (canonical) registry and
 * produces a content-addressed reference through the shared reference provider
 * — the same canonicalization pathway the other experiments use.
 */
export async function buildRequiredReferences(
  scenario: A2aDriftScenario,
  requesterRegistry: AgentRegistry,
  referenceProvider: SemanticReferenceProvider,
): Promise<SemanticReference[]> {
  const references: SemanticReference[] = [];
  for (const handle of scenario.acceptanceHandles) {
    const definition = requesterRegistry.resolve(handle);
    const reference = await referenceProvider.reference(handle, definition);
    references.push({
      handle,
      ref: reference.full,
      digest: reference.digest,
      canonicalizationVersion: reference.backend,
    });
  }
  return references;
}

/** Deterministic id for the acceptance contract of a (scenario, condition). */
function contractId(scenario: A2aDriftScenario): string {
  return `contract-${fingerprint({ scenario: scenario.id, handles: scenario.acceptanceHandles }).slice(0, 12)}`;
}

/** Deterministic message id derived from the scenario and condition. */
function messageId(scenario: A2aDriftScenario, condition: string): string {
  return `msg-${fingerprint({ scenario: scenario.id, condition }).slice(0, 16)}`;
}

/**
 * Builds the task message the requester sends. Every condition carries the
 * A2A TextPart (the task) plus a DataPart naming the handles by name — that is
 * all baseline carries. The extension conditions additionally attach a tagged
 * DataPart bearing the acceptance contract (content-addressed references), so
 * the semantic content rides in a spec-defined DataPart tagged with the
 * extension URI and no core field is repurposed.
 */
export function buildTaskMessage(
  scenario: A2aDriftScenario,
  condition: A2aDriftCondition,
  references: SemanticReference[] | undefined,
): { message: A2aMessage; contract: AcceptanceContract | undefined } {
  const policy = conditionPolicy(condition);
  const parts: Part[] = [
    { kind: "text", text: scenario.task },
    {
      kind: "data",
      data: { requestedHandles: scenario.acceptanceHandles },
    },
  ];

  let contract: AcceptanceContract | undefined;
  if (policy.carriesReferences) {
    if (!references) {
      throw new Error(
        `Condition ${condition} carries references but none were supplied.`,
      );
    }
    contract = {
      contractId: contractId(scenario),
      extensionUri: SEMANTIC_EXTENSION_URI,
      enforcement: advertisedEnforcement(condition),
      requiredReferences: references,
    };
    const contractPart: DataPart = {
      kind: "data",
      data: { acceptanceContract: contract },
      metadata: { extensionUri: SEMANTIC_EXTENSION_URI },
    };
    parts.push(contractPart);
  }

  const message: A2aMessage = {
    role: "user",
    parts,
    messageId: messageId(scenario, condition),
  };
  return { message, contract };
}

/** Extracts the semantic acceptance contract from a task message, if any. A
 * non-participating (baseline) agent simply finds no such part. */
export function extractAcceptanceContract(
  message: A2aMessage,
): AcceptanceContract | undefined {
  for (const part of message.parts) {
    if (
      part.kind === "data" &&
      part.metadata?.["extensionUri"] === SEMANTIC_EXTENSION_URI
    ) {
      const contract = part.data["acceptanceContract"];
      return contract as AcceptanceContract;
    }
  }
  return undefined;
}

/** Bytes the worker fetches from its own registry to resolve the acceptance
 * handles. Present in every condition — the worker always needs definitions to
 * do the work — so drift always sits in this hydration channel. */
export function hydrationBytesFor(
  scenario: A2aDriftScenario,
  workerRegistry: AgentRegistry,
): number {
  const resolved: Record<string, unknown> = {};
  for (const handle of scenario.acceptanceHandles) {
    resolved[handle] = workerRegistry.resolve(handle);
  }
  return utf8Bytes(resolved);
}
