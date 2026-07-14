import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FixtureReferenceProvider,
  OpenAiCompatibleModelAdapter,
  type OpenAiFetchInit,
  type OpenAiFetchResponse,
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
  runModelRelayTrial,
  type ModelRelayAdapters,
} from "../src/model-relay.js";

const ENV_VAR = "CHUTES_API_KEY";
const BASE_URL = "https://llm.chutes.ai/v1";

beforeEach(() => {
  process.env[ENV_VAR] = "sk-test-openai-compat";
});

afterEach(() => {
  delete process.env[ENV_VAR];
});

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
  modelProvider: "llm.chutes.ai",
  modelName: "zai-org/GLM-4.6-FP8",
};

const canonicalDefinition = { invariant: "amount >= 100", unit: "usdc" };

function controlScenario(): RelayScenario {
  return {
    id: "control",
    title: "Control",
    description: "Apply the exact boundary rule.",
    contract: {
      handle: "BoundaryRule",
      opaqueRef: "rule:boundary-v1",
      canonicalDefinition,
      mutatedDefinition: canonicalDefinition,
    },
    mutation: null,
    expectedAction: "proceed",
  };
}

function cellFor(
  scenario: RelayScenario,
  condition: ExperimentCondition,
): MatrixCell<RelayScenario, ExperimentCondition> {
  const [cell] = planPairedMatrix({
    experimentId: "babel-relay-openai-test",
    protocolVersion: PROTOCOL_VERSION,
    scenarios: [scenario],
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

function fetchReturning(
  text: string,
): (url: string, init: OpenAiFetchInit) => Promise<OpenAiFetchResponse> {
  const body = JSON.stringify({
    id: "cmpl_test",
    model: "zai-org/GLM-4.6-FP8",
    choices: [
      { message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  });
  return async () => ({ status: 200, text: async () => body });
}

function buildAdapters(
  texts: Record<RelayBoundary, string>,
): ModelRelayAdapters {
  const build = (boundary: RelayBoundary): OpenAiCompatibleModelAdapter =>
    new OpenAiCompatibleModelAdapter({
      systemPrompt: `Role: ${boundary}`,
      baseUrl: BASE_URL,
      model: "zai-org/GLM-4.6-FP8",
      fetchFn: fetchReturning(texts[boundary]),
      sleep: async () => {},
      backoffBaseMs: 1,
    });
  return {
    "spec-to-plan": build("spec-to-plan"),
    "plan-to-implementation": build("plan-to-implementation"),
    "implementation-to-audit": build("implementation-to-audit"),
  };
}

describe("runModelRelayTrial with OpenAiCompatibleModelAdapter", () => {
  it("produces a schema-valid record with non-null usage and transcript", async () => {
    const adapters = buildAdapters({
      "spec-to-plan": "plan artifact",
      "plan-to-implementation": "impl artifact",
      "implementation-to-audit": "Everything matches.\nDECISION: PROCEED",
    });

    const record = await runModelRelayTrial(
      cellFor(controlScenario(), "equal-prose"),
      {
        experimentId: "babel-relay-openai-test",
        referenceProvider: new FixtureReferenceProvider(),
        provenance,
        adapters,
      },
    );

    expect(trialRecordSchema.safeParse(record).success).toBe(true);
    expect(record.actualAction).toBe("proceed");
    expect(record.metrics.taskSuccess).toBe(true);
    expect(record.usage).not.toBeNull();
    expect(record.transcript).not.toBeNull();
    // Three hops, each reporting 12/8 tokens and 3 reasoning tokens.
    expect(record.usage?.inputTokens).toBe(36);
    expect(record.usage?.outputTokens).toBe(24);
    expect(record.usage?.reasoningTokens).toBe(9);
  });
});
