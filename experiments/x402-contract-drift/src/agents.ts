import { type SemanticReferenceProvider } from "@sema-evals/adapters";
import { fingerprint, utf8Bytes } from "@sema-evals/core";

import { conditionPolicy } from "./conditions.js";
import type { PartyRegistry } from "./registry.js";
import {
  SEMANTIC_EXTENSION_URI,
  X402_PROTOCOL_VERSION,
  type AcceptanceContract,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentRequirementsResponse,
  type ResourceInfo,
  type SemanticReference,
  type SettlementResponse,
  type X402Extensions,
  type X402DriftCondition,
  type X402DriftScenario,
} from "./schemas.js";

/** Deterministic simulated payer address — no real wallet. */
export const SIMULATED_PAYER_ADDRESS =
  "0x857b06519E91e3A54538791bDbb0E22373e36b66";

/** The extension enforcement mode a condition advertises in `extra`. */
function advertisedEnforcement(
  condition: X402DriftCondition,
): "voluntary" | "enforced" {
  return condition === "advertised-enforced" ? "enforced" : "voluntary";
}

/**
 * Resolves each acceptance handle from the seller's (canonical) registry and
 * produces a content-addressed reference through the shared reference provider
 * — the same canonicalization pathway the other experiments use.
 */
export async function buildRequiredReferences(
  scenario: X402DriftScenario,
  sellerRegistry: PartyRegistry,
  referenceProvider: SemanticReferenceProvider,
): Promise<SemanticReference[]> {
  const references: SemanticReference[] = [];
  for (const handle of scenario.acceptanceHandles) {
    const definition = sellerRegistry.resolve(handle);
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

/** Deterministic id for the acceptance contract of a scenario. */
function contractId(scenario: X402DriftScenario): string {
  return `contract-${fingerprint({ scenario: scenario.id, handles: scenario.acceptanceHandles }).slice(0, 12)}`;
}

/**
 * Builds the seller's V2 PaymentRequirements. The semantic contract is not
 * placed in scheme-specific `extra`; it is advertised in PaymentRequired's
 * top-level `extensions` map by {@link buildPaymentRequirementsResponse}.
 */
export function buildPaymentRequirements(
  scenario: X402DriftScenario,
  condition: X402DriftCondition,
  references: SemanticReference[] | undefined,
): {
  requirements: PaymentRequirements;
  contract: AcceptanceContract | undefined;
} {
  const policy = conditionPolicy(condition);
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
  }

  const requirements: PaymentRequirements = {
    scheme: scenario.scheme,
    network: scenario.network,
    amount: scenario.amount,
    asset: scenario.asset,
    payTo: scenario.payTo,
    maxTimeoutSeconds: scenario.maxTimeoutSeconds,
    extra: {
      name: "USDC",
      version: "2",
    },
  };

  return { requirements, contract };
}

/** Builds the 402 payment-required envelope containing one accepts entry. */
export function buildPaymentRequirementsResponse(
  requirements: PaymentRequirements,
  scenario: X402DriftScenario,
  contract: AcceptanceContract | undefined,
): PaymentRequirementsResponse {
  const handleList = scenario.acceptanceHandles.join(", ");
  const resource: ResourceInfo = {
    url: scenario.resource,
    description: `${scenario.resourceDescription} Terms: ${handleList}.`,
    mimeType: "application/json",
  };
  const extensions: X402Extensions = contract
    ? {
        [SEMANTIC_EXTENSION_URI]: {
          info: contract,
          schema: {
            type: "object",
            required: [
              "contractId",
              "extensionUri",
              "enforcement",
              "requiredReferences",
            ],
          },
        },
      }
    : {};
  return {
    x402Version: X402_PROTOCOL_VERSION,
    error: "PAYMENT-SIGNATURE header is required",
    resource,
    accepts: [requirements],
    extensions,
  };
}

/** Extracts the semantic acceptance contract from V2 top-level extensions. */
export function extractAcceptanceContract(
  extensions: X402Extensions,
): AcceptanceContract | undefined {
  return extensions[SEMANTIC_EXTENSION_URI]?.info;
}

/**
 * Builds a PaymentPayload with deterministically simulated signing. No crypto
 * libraries and no chain interaction — the signature and nonce are derived from
 * a content fingerprint of the authorization fields (ADR 0016).
 */
export function buildPaymentPayload(
  requirements: PaymentRequirements,
  scenario: X402DriftScenario,
  resource: ResourceInfo,
  extensions: X402Extensions,
): PaymentPayload {
  const validAfter = "0";
  const validBefore = String(scenario.maxTimeoutSeconds);
  const authorization = {
    from: SIMULATED_PAYER_ADDRESS,
    to: requirements.payTo,
    value: requirements.amount,
    validAfter,
    validBefore,
    nonce: `0x${fingerprint({
      from: SIMULATED_PAYER_ADDRESS,
      to: requirements.payTo,
      value: requirements.amount,
      resource: resource.url,
    }).slice(0, 64)}`,
  };
  const signature = `sim-sig-${fingerprint({
    scheme: requirements.scheme,
    network: requirements.network,
    authorization,
  }).slice(0, 32)}`;

  return {
    x402Version: X402_PROTOCOL_VERSION,
    resource,
    accepted: requirements,
    payload: { signature, authorization },
    extensions,
  };
}

/** Simulated facilitator settlement after a successful PaymentPayload emit. */
export function buildSettlementResponse(
  requirements: PaymentRequirements,
  payload: PaymentPayload,
): SettlementResponse {
  return {
    success: true,
    transaction: `0x${fingerprint({
      signature: payload.payload.signature,
      resource: payload.resource?.url,
    }).slice(0, 64)}`,
    network: requirements.network,
    payer: payload.payload.authorization.from,
    amount: requirements.amount,
  };
}

/** Bytes the payer fetches from its own registry to resolve acceptance handles. */
export function hydrationBytesFor(
  scenario: X402DriftScenario,
  payerRegistry: PartyRegistry,
): number {
  const resolved: Record<string, unknown> = {};
  for (const handle of scenario.acceptanceHandles) {
    resolved[handle] = payerRegistry.resolve(handle);
  }
  return utf8Bytes(resolved);
}
