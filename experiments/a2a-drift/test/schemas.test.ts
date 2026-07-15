import { describe, expect, it } from "vitest";

import {
  buildAgentCard,
  buildRequesterCard,
  buildTaskMessage,
  buildWorkerCard,
  extractAcceptanceContract,
} from "../src/agents.js";
import {
  SEMANTIC_EXTENSION_URI,
  a2aMessageSchema,
  acceptanceContractSchema,
  agentCardSchema,
  partSchema,
  type A2aDriftScenario,
  type SemanticReference,
} from "../src/schemas.js";

const METADATA = {
  backend: "fixture-sha256-stable-json-v1",
  semaVersion: "not-connected",
  canonicalizationVersion: "fixture-stable-json-v1",
  officialSema: false,
};

const SCENARIO: A2aDriftScenario = {
  id: "unit-scenario",
  title: "Unit scenario",
  description: "For schema round-trip tests.",
  task: "Do the task within the referenced patterns.",
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

describe("Agent Card extension advertisement", () => {
  it("advertises the semantic extension in capabilities.extensions with canonicalization + vocabulary root", () => {
    const card = buildAgentCard({
      name: "worker",
      description: "desc",
      url: "inproc://worker",
      skillId: "s",
      skillName: "skill",
      skillDescription: "does",
      extension: {
        metadata: METADATA,
        vocabularyRoot: "vocab-root-xyz",
        enforcement: "enforced",
        required: true,
      },
    });
    const parsed = agentCardSchema.parse(card);
    expect(parsed.capabilities.extensions).toHaveLength(1);
    const extension = parsed.capabilities.extensions[0];
    expect(extension?.uri).toBe(SEMANTIC_EXTENSION_URI);
    expect(extension?.required).toBe(true);
    expect(extension?.params["canonicalizationVersion"]).toBe(
      "fixture-stable-json-v1",
    );
    expect(extension?.params["vocabularyRoot"]).toBe("vocab-root-xyz");
    expect(extension?.params["enforcement"]).toBe("enforced");
  });

  it("omits the extension entirely for baseline cards", () => {
    const requester = agentCardSchema.parse(
      buildRequesterCard("baseline", METADATA, ""),
    );
    const worker = agentCardSchema.parse(
      buildWorkerCard("baseline", METADATA, ""),
    );
    expect(requester.capabilities.extensions).toHaveLength(0);
    expect(worker.capabilities.extensions).toHaveLength(0);
  });

  it("advertises voluntary vs enforced per condition, and marks required only when enforced", () => {
    const voluntary = buildWorkerCard("advertised-voluntary", METADATA, "");
    const enforced = buildWorkerCard("advertised-enforced", METADATA, "");
    expect(voluntary.capabilities.extensions[0]?.params["enforcement"]).toBe(
      "voluntary",
    );
    expect(voluntary.capabilities.extensions[0]?.required).toBe(false);
    expect(enforced.capabilities.extensions[0]?.params["enforcement"]).toBe(
      "enforced",
    );
    expect(enforced.capabilities.extensions[0]?.required).toBe(true);
  });
});

describe("task message and typed parts round-trip", () => {
  it("baseline carries a text part and handle names only, no acceptance contract", () => {
    const { message, contract } = buildTaskMessage(
      SCENARIO,
      "baseline",
      undefined,
    );
    const parsed = a2aMessageSchema.parse(message);
    expect(contract).toBeUndefined();
    expect(extractAcceptanceContract(parsed)).toBeUndefined();
    const kinds = parsed.parts.map((part) => part.kind);
    expect(kinds).toContain("text");
    // No part is tagged with the extension URI.
    for (const part of parsed.parts) {
      if (part.kind === "data") {
        expect(part.metadata?.["extensionUri"]).toBeUndefined();
      }
    }
  });

  it("extension conditions attach a DataPart tagged with the extension URI carrying the acceptance contract", () => {
    const { message, contract } = buildTaskMessage(
      SCENARIO,
      "advertised-enforced",
      REFERENCES,
    );
    const parsed = a2aMessageSchema.parse(message);
    expect(contract).toBeDefined();
    const extracted = extractAcceptanceContract(parsed);
    expect(extracted).toBeDefined();
    const validContract = acceptanceContractSchema.parse(extracted);
    expect(validContract.extensionUri).toBe(SEMANTIC_EXTENSION_URI);
    expect(validContract.enforcement).toBe("enforced");
    expect(validContract.requiredReferences).toHaveLength(2);
    // The text part (the actual task) is preserved and never repurposed.
    const textPart = parsed.parts.find((part) => part.kind === "text");
    expect(textPart?.kind === "text" && textPart.text).toBe(SCENARIO.task);
  });

  it("rejects a part with an unknown kind (discriminated union is closed)", () => {
    expect(partSchema.safeParse({ kind: "file", file: {} }).success).toBe(
      false,
    );
  });

  it("throws when a reference-carrying condition is built without references", () => {
    expect(() =>
      buildTaskMessage(SCENARIO, "advertised-voluntary", undefined),
    ).toThrow(/carries references/);
  });
});
