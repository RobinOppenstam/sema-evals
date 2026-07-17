import { describe, expect, it } from "vitest";

import {
  buildPaymentPayload,
  buildPaymentRequirements,
  buildPaymentRequirementsResponse,
  extractAcceptanceContract,
} from "../src/agents.js";
import {
  SEMANTIC_EXTENSION_URI,
  acceptanceContractSchema,
  paymentPayloadSchema,
  paymentRequirementsResponseSchema,
  paymentRequirementsSchema,
  settlementResponseSchema,
  type SemanticReference,
  type X402DriftScenario,
} from "../src/schemas.js";

const SCENARIO: X402DriftScenario = {
  id: "unit-scenario",
  title: "Unit scenario",
  description: "For schema round-trip tests.",
  resourceDescription: "Unit test resource.",
  resource: "https://api.example.com/unit",
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  patterns: [
    { handle: "Alpha", definition: { comparator: "<=", threshold: 10 } },
    { handle: "Beta", definition: { comparator: ">=", threshold: 2 } },
  ],
  acceptanceHandles: ["Alpha", "Beta"],
  drift: null,
};

const REFERENCES: SemanticReference[] = [
  {
    handle: "Alpha",
    ref: "fixture:Alpha#sha256:" + "a".repeat(64),
    digest: "a".repeat(64),
    canonicalizationVersion: "fixture-stable-json-v1",
  },
  {
    handle: "Beta",
    ref: "fixture:Beta#sha256:" + "b".repeat(64),
    digest: "b".repeat(64),
    canonicalizationVersion: "fixture-stable-json-v1",
  },
];

describe("x402 wire shape round-trips", () => {
  it("round-trips PaymentRequirements, PaymentPayload, and SettlementResponse", () => {
    const { requirements, contract } = buildPaymentRequirements(
      SCENARIO,
      "advertised-enforced",
      REFERENCES,
    );
    const parsedRequirements = paymentRequirementsSchema.parse(requirements);
    expect(parsedRequirements.amount).toBe("1000");
    expect(parsedRequirements.network).toBe("eip155:84532");

    const envelope = paymentRequirementsResponseSchema.parse(
      buildPaymentRequirementsResponse(parsedRequirements, SCENARIO, contract),
    );
    expect(envelope.x402Version).toBe(2);
    expect(envelope.accepts).toHaveLength(1);
    expect(envelope.resource.url).toBe(SCENARIO.resource);
    expect(extractAcceptanceContract(envelope.extensions)).toEqual(contract);

    const payload = paymentPayloadSchema.parse(
      buildPaymentPayload(
        parsedRequirements,
        SCENARIO,
        envelope.resource,
        envelope.extensions,
      ),
    );
    expect(payload.payload.signature.startsWith("sim-sig-")).toBe(true);
    expect(payload.payload.authorization.value).toBe("1000");
    expect(payload.accepted).toEqual(parsedRequirements);

    const settlement = settlementResponseSchema.parse({
      success: true,
      transaction: "0x" + "c".repeat(64),
      network: "eip155:84532",
      payer: payload.payload.authorization.from,
    });
    expect(settlement.success).toBe(true);
  });
});

describe("extension placement in PaymentRequired.extensions", () => {
  it("omits the semantic extension for baseline", () => {
    const { requirements, contract } = buildPaymentRequirements(
      SCENARIO,
      "baseline",
      undefined,
    );
    const parsed = paymentRequirementsSchema.parse(requirements);
    expect(contract).toBeUndefined();
    const envelope = buildPaymentRequirementsResponse(
      parsed,
      SCENARIO,
      contract,
    );
    expect(extractAcceptanceContract(envelope.extensions)).toBeUndefined();
  });

  it("advertised conditions round-trip the top-level acceptance extension", () => {
    const { requirements, contract } = buildPaymentRequirements(
      SCENARIO,
      "advertised-voluntary",
      REFERENCES,
    );
    const parsed = paymentRequirementsSchema.parse(requirements);
    expect(contract).toBeDefined();
    const envelope = buildPaymentRequirementsResponse(
      parsed,
      SCENARIO,
      contract,
    );
    const extracted = extractAcceptanceContract(envelope.extensions);
    expect(extracted).toBeDefined();
    const validContract = acceptanceContractSchema.parse(extracted);
    expect(validContract.extensionUri).toBe(SEMANTIC_EXTENSION_URI);
    expect(validContract.enforcement).toBe("voluntary");
    expect(validContract.requiredReferences).toHaveLength(2);
    // Core fields stay untouched.
    expect(parsed.scheme).toBe("exact");
    expect(parsed.amount).toBe("1000");
  });

  it("marks enforced vs voluntary per condition", () => {
    const voluntary = buildPaymentRequirements(
      SCENARIO,
      "advertised-voluntary",
      REFERENCES,
    );
    const enforced = buildPaymentRequirements(
      SCENARIO,
      "advertised-enforced",
      REFERENCES,
    );
    expect(voluntary.contract?.enforcement).toBe("voluntary");
    expect(enforced.contract?.enforcement).toBe("enforced");
  });

  it("throws when a reference-carrying condition is built without references", () => {
    expect(() =>
      buildPaymentRequirements(SCENARIO, "advertised-voluntary", undefined),
    ).toThrow(/carries references/);
  });
});
