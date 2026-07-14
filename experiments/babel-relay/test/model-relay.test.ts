import { describe, expect, it, vi } from "vitest";

import {
  AnthropicModelAdapter,
  FixtureReferenceProvider,
  type AnthropicMessageClient,
  type AnthropicMessageRequest,
  type AnthropicMessageResponse,
} from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  planPairedMatrix,
  trialRecordSchema,
  type ExperimentCondition,
  type MatrixCell,
  type RelayBoundary,
  type RelayScenario,
  type TrialProvenance,
} from "@sema-evals/core";

import {
  buildHopUserMessage,
  parseAuditDecision,
  runModelRelayTrial,
  stableDefinitionText,
  type ModelRelayAdapters,
} from "../src/model-relay.js";

const provenance: TrialProvenance = {
  artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  fixtureDigest: "a".repeat(64),
  implementationCommit: "test",
  dependencyLockDigest: "b".repeat(64),
  promptDigest: "c".repeat(64),
  semaVersion: "not-connected",
  canonicalizationVersion: "fixture-stable-json-v1",
  vocabularyRoot: "",
  semanticBackend: "fixture-sha256-stable-json-v1",
  modelProvider: "anthropic",
  modelName: "claude-sonnet-5",
};

const BOUNDARIES: readonly RelayBoundary[] = [
  "spec-to-plan",
  "plan-to-implementation",
  "implementation-to-audit",
];

const canonicalDefinition = { invariant: "amount >= 100", unit: "usdc" };
const mutatedDefinition = { invariant: "amount > 100", unit: "usdc" };

function scenario(options: {
  drift: boolean;
  boundary?: RelayBoundary;
}): RelayScenario {
  const boundary = options.boundary ?? "plan-to-implementation";
  return {
    id: options.drift ? "drift" : "control",
    title: options.drift ? "Drift" : "Control",
    description: "Apply the exact boundary rule.",
    contract: {
      handle: "BoundaryRule",
      opaqueRef: "rule:boundary-v1",
      canonicalDefinition,
      mutatedDefinition: options.drift
        ? mutatedDefinition
        : canonicalDefinition,
    },
    mutation: options.drift
      ? {
          boundary,
          fieldPath: "invariant",
          before: "amount >= 100",
          after: "amount > 100",
        }
      : null,
    expectedAction: options.drift ? "halt" : "proceed",
  };
}

function cellFor(
  entry: RelayScenario,
  condition: ExperimentCondition,
): MatrixCell<RelayScenario, ExperimentCondition> {
  const [cell] = planPairedMatrix({
    experimentId: "babel-relay-model-test",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: [entry],
    scenarioId: (value) => value.id,
    conditions: [condition],
    seeds: [0],
    orderSeed: 1,
  });
  if (!cell) {
    throw new Error("Expected one matrix cell.");
  }
  return cell;
}

function textResponse(
  text: string,
  overrides: Partial<AnthropicMessageResponse> = {},
): AnthropicMessageResponse {
  return {
    id: "msg_test",
    model: "claude-sonnet-5",
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

type Responder = (
  request: AnthropicMessageRequest,
) => AnthropicMessageResponse | Promise<AnthropicMessageResponse>;

function buildAdapters(
  responders: Record<RelayBoundary, Responder>,
  records: Record<RelayBoundary, AnthropicMessageRequest[]>,
): ModelRelayAdapters {
  const build = (boundary: RelayBoundary): AnthropicModelAdapter => {
    const client: AnthropicMessageClient = {
      messages: {
        create: async (request) => {
          records[boundary].push(request);
          return responders[boundary](request);
        },
      },
    };
    return new AnthropicModelAdapter({
      systemPrompt: `Role: ${boundary}`,
      client,
      sleep: async () => {},
      backoffBaseMs: 1,
    });
  };
  return {
    "spec-to-plan": build("spec-to-plan"),
    "plan-to-implementation": build("plan-to-implementation"),
    "implementation-to-audit": build("implementation-to-audit"),
  };
}

function emptyRecords(): Record<RelayBoundary, AnthropicMessageRequest[]> {
  return {
    "spec-to-plan": [],
    "plan-to-implementation": [],
    "implementation-to-audit": [],
  };
}

function proceedAudit(): Responder {
  return () => textResponse("Everything matches.\nDECISION: PROCEED");
}

function passthrough(label: string): Responder {
  return () => textResponse(`${label} artifact`);
}

async function runOne(
  entry: RelayScenario,
  condition: ExperimentCondition,
  responders: Record<RelayBoundary, Responder>,
) {
  const records = emptyRecords();
  const adapters = buildAdapters(responders, records);
  const record = await runModelRelayTrial(cellFor(entry, condition), {
    experimentId: "babel-relay-model-test",
    referenceProvider: new FixtureReferenceProvider(),
    provenance,
    adapters,
  });
  return { record, records };
}

describe("parseAuditDecision", () => {
  it("parses PROCEED, HALT, and preserves malformed", () => {
    expect(parseAuditDecision("ok\nDECISION: PROCEED")).toBe("proceed");
    expect(parseAuditDecision("bad\nDECISION: HALT\n")).toBe("halt");
    expect(parseAuditDecision("no decision line here")).toBe("malformed");
    expect(parseAuditDecision("DECISION: proceed")).toBe("malformed");
    // The last valid decision line wins.
    expect(parseAuditDecision("DECISION: PROCEED\nDECISION: HALT")).toBe(
      "halt",
    );
  });
});

describe("runModelRelayTrial information parity", () => {
  it("gives equal-prose and addressed byte-identical resolved definitions", async () => {
    const control = scenario({ drift: false });
    const equalProse = await runOne(control, "equal-prose", {
      "spec-to-plan": passthrough("plan"),
      "plan-to-implementation": passthrough("impl"),
      "implementation-to-audit": proceedAudit(),
    });
    const addressed = await runOne(control, "addressed-voluntary", {
      "spec-to-plan": passthrough("plan"),
      "plan-to-implementation": passthrough("impl"),
      "implementation-to-audit": proceedAudit(),
    });

    const block = `## Resolved definition\n${stableDefinitionText(
      canonicalDefinition,
    )}`;
    for (const boundary of BOUNDARIES) {
      const proseMessage =
        equalProse.records[boundary][0]?.messages[0]?.content ?? "";
      const addressedMessage =
        addressed.records[boundary][0]?.messages[0]?.content ?? "";
      expect(proseMessage).toContain(block);
      expect(addressedMessage).toContain(block);
    }
    // The direct renderer agrees for the two conditions.
    const renderArgs = {
      scenario: control,
      upstream: "same upstream",
      definition: canonicalDefinition,
      opaqueRef: control.contract.opaqueRef,
      contentReference: "sema:BoundaryRule#abcd",
    };
    expect(
      buildHopUserMessage({ ...renderArgs, condition: "equal-prose" }),
    ).toContain(block);
    expect(
      buildHopUserMessage({ ...renderArgs, condition: "addressed-enforced" }),
    ).toContain(block);
  });

  it("sends the opaque ref, not the inline definition, on the wire pre-resolution", async () => {
    const { record, records } = await runOne(
      scenario({ drift: false }),
      "opaque-resolver",
      {
        "spec-to-plan": passthrough("plan"),
        "plan-to-implementation": passthrough("impl"),
        "implementation-to-audit": proceedAudit(),
      },
    );

    const message = record.events.find((event) => event.type === "message");
    expect(message?.details.payload).toEqual({
      semanticRef: "rule:boundary-v1",
    });
    expect(JSON.stringify(message?.details.payload)).not.toContain("invariant");

    // Post-resolution, the model still receives the resolved definition.
    const userMessage = records["spec-to-plan"][0]?.messages[0]?.content ?? "";
    expect(userMessage).toContain("rule:boundary-v1");
    expect(userMessage).toContain(stableDefinitionText(canonicalDefinition));
  });
});

describe("runModelRelayTrial scoring", () => {
  it("scores a drifted audit under no enforcement as a silent divergence", async () => {
    const { record } = await runOne(scenario({ drift: true }), "equal-prose", {
      "spec-to-plan": passthrough("plan"),
      "plan-to-implementation": passthrough("impl"),
      "implementation-to-audit": proceedAudit(),
    });

    expect(record.metrics.driftInjected).toBe(true);
    expect(record.metrics.driftDetected).toBe(false);
    expect(record.metrics.silentDivergence).toBe(true);
    expect(record.actualAction).toBe("proceed");
    expect(record.metrics.taskSuccess).toBe(false);
    expect(trialRecordSchema.safeParse(record).success).toBe(true);
  });

  it("counts a reasoning halt as detection, not silent divergence", async () => {
    const { record } = await runOne(scenario({ drift: true }), "equal-prose", {
      "spec-to-plan": passthrough("plan"),
      "plan-to-implementation": passthrough("impl"),
      "implementation-to-audit": () =>
        textResponse("The comparator changed.\nDECISION: HALT"),
    });

    expect(record.metrics.driftDetected).toBe(true);
    expect(record.metrics.silentDivergence).toBe(false);
    expect(record.metrics.halted).toBe(true);
    expect(record.actualAction).toBe("halt");
    expect(record.metrics.correctHalt).toBe(true);
    expect(record.metrics.taskSuccess).toBe(true);
  });

  it("halts at the enforcing boundary without calling downstream models", async () => {
    const auditFake = vi.fn(proceedAudit());
    const implFake = vi.fn(passthrough("impl"));
    const { record, records } = await runOne(
      scenario({ drift: true, boundary: "plan-to-implementation" }),
      "addressed-enforced",
      {
        "spec-to-plan": passthrough("plan"),
        "plan-to-implementation": implFake,
        "implementation-to-audit": auditFake,
      },
    );

    expect(record.actualAction).toBe("halt");
    expect(record.metrics.halted).toBe(true);
    expect(record.metrics.correctHalt).toBe(true);
    expect(record.metrics.detectionBoundary).toBe("plan-to-implementation");
    expect(records["spec-to-plan"]).toHaveLength(1);
    expect(implFake).not.toHaveBeenCalled();
    expect(auditFake).not.toHaveBeenCalled();
    expect(record.events.some((event) => event.type === "halt")).toBe(true);
    expect(trialRecordSchema.safeParse(record).success).toBe(true);
  });

  it("stays schema-valid when enforcement halts before any model call", async () => {
    const specFake = vi.fn(passthrough("plan"));
    const implFake = vi.fn(passthrough("impl"));
    const auditFake = vi.fn(proceedAudit());
    const { record } = await runOne(
      scenario({ drift: true, boundary: "spec-to-plan" }),
      "addressed-enforced",
      {
        "spec-to-plan": specFake,
        "plan-to-implementation": implFake,
        "implementation-to-audit": auditFake,
      },
    );

    expect(record.actualAction).toBe("halt");
    expect(record.metrics.correctHalt).toBe(true);
    expect(record.metrics.detectionBoundary).toBe("spec-to-plan");
    expect(specFake).not.toHaveBeenCalled();
    expect(implFake).not.toHaveBeenCalled();
    expect(auditFake).not.toHaveBeenCalled();
    expect(record.usage).toBeNull();
    expect(record.transcript).toBeNull();
    expect(trialRecordSchema.safeParse(record).success).toBe(true);
  });

  it("preserves a malformed audit output as a failure with the transcript", async () => {
    const { record } = await runOne(scenario({ drift: false }), "equal-prose", {
      "spec-to-plan": passthrough("plan"),
      "plan-to-implementation": passthrough("impl"),
      "implementation-to-audit": () =>
        textResponse("I think the implementation is basically fine."),
    });

    expect(record.metrics.taskSuccess).toBe(false);
    expect(record.transcript).not.toBeNull();
    const transcriptText = JSON.stringify(record.transcript);
    expect(transcriptText).toContain("basically fine");
    const completion = record.events.find(
      (event) => event.type === "completion",
    );
    expect(completion?.details.auditMalformed).toBe(true);
    expect(trialRecordSchema.safeParse(record).success).toBe(true);
  });

  it("aggregates usage and attempts across every hop", async () => {
    let specCalls = 0;
    const { record } = await runOne(scenario({ drift: false }), "equal-prose", {
      "spec-to-plan": () => {
        specCalls += 1;
        if (specCalls === 1) {
          throw Object.assign(new Error("overloaded"), { status: 529 });
        }
        return textResponse("plan artifact");
      },
      "plan-to-implementation": passthrough("impl"),
      "implementation-to-audit": proceedAudit(),
    });

    // Three successful responses each report 10 input / 5 output tokens.
    expect(record.usage?.inputTokens).toBe(30);
    expect(record.usage?.outputTokens).toBe(15);
    // spec hop: 2 attempts (1 retry), impl + audit: 1 attempt each.
    expect(record.usage?.attempts).toBe(4);
    expect(record.usage?.retries).toBe(1);
    expect(record.usage?.errors).toEqual(["overloaded"]);
    expect(record.metrics.taskSuccess).toBe(true);
    expect(trialRecordSchema.safeParse(record).success).toBe(true);
  });
});
