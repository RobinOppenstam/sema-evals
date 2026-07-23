import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ModelAgentAdapter,
  ModelCompletion,
  ModelPromptInput,
} from "@sema-evals/adapters";
import { FixtureReferenceProvider } from "@sema-evals/adapters";
import { describe, expect, it } from "vitest";

import { loadFixtureFile } from "../src/fixtures.js";
import { runModelForecastingTrial } from "../src/model-demo.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenance = {
  artifactSchemaVersion: "0.3.0",
  protocolVersion: "0.3.0",
  fixtureDigest: "a".repeat(64),
  implementationCommit: "test",
  dependencyLockDigest: "b".repeat(64),
  promptDigest: "c".repeat(64),
  semaVersion: "not-connected",
  canonicalizationVersion: "fixture-stable-json-v1",
  vocabularyRoot: "",
  semanticBackend: "fixture-sha256-stable-json-v1",
  modelProvider: "fake",
  modelName: "malformed-model",
};

const malformedAdapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion> = {
  descriptor: {
    id: "fake",
    provider: "fake",
    model: "malformed",
    deterministic: true,
  },
  invoke: async () => ({
    output: { status: "completed", text: "not-json", stopReason: "end" },
    transcript: {
      entries: [
        {
          index: 0,
          attempt: 0,
          role: "assistant",
          content: [
            { type: "text", text: "not-json", toolName: null, toolInput: null },
          ],
          raw: null,
        },
      ],
    },
    usage: {
      inputTokens: 1,
      cachedInputTokensRead: 0,
      cachedInputTokensWritten: 0,
      reasoningTokens: null,
      outputTokens: 1,
      attempts: 1,
      retries: 0,
      errors: [],
      latencyMs: 1,
      stopReason: "end",
      costUsd: null,
    },
    elapsedMs: 1,
    raw: null,
  }),
};

describe("model forecasting trial failure preservation", () => {
  it("settles and preserves every malformed member call instead of throwing", async () => {
    const fixture = await loadFixtureFile(
      join(ROOT, "fixtures/scenarios.yaml"),
    );
    const scenario = fixture.fixtureSet.scenarios[0]!;
    const record = await runModelForecastingTrial(
      {
        trialId: "d".repeat(64),
        scenario,
        scenarioId: scenario.id,
        condition: "baseline",
        seed: 0,
        executionIndex: 0,
      },
      {
        experimentId: "forecasting",
        referenceProvider: new FixtureReferenceProvider(),
        vocabularyRoot: "",
        provenance,
        adapter: malformedAdapter,
      },
    );
    expect(record.round1Forecasts).toEqual([]);
    expect(record.round2Forecasts).toEqual([]);
    expect(record.metrics.forecastsSubmitted).toBe(0);
    expect(record.metrics.aggregateProbability).toBeNull();
    expect(record.metrics.independentAverage).toBeNull();
    expect(record.metrics.brierIndependentAverage).toBeNull();
    expect(record.usage?.attempts).toBe(scenario.agents.length * 2);
    expect(record.transcript?.entries).toHaveLength(scenario.agents.length * 2);
    expect(
      record.events.filter(
        (event) =>
          event.type === "message" && event.details.parseFailure !== null,
      ),
    ).toHaveLength(scenario.agents.length * 2);
  });

  it("keeps model requests condition-neutral while serving identical frozen evidence", async () => {
    const fixture = await loadFixtureFile(
      join(ROOT, "fixtures/scenarios.yaml"),
    );
    const scenario = fixture.fixtureSet.scenarios[0]!;
    const requests: string[] = [];
    const adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion> = {
      ...malformedAdapter,
      invoke: async (input) => {
        const request = JSON.parse(input.messages[0]?.content ?? "{}") as {
          agentId: string;
        };
        requests.push(input.messages[0]?.content ?? "");
        return {
          ...(await malformedAdapter.invoke(input)),
          output: {
            status: "completed" as const,
            text: JSON.stringify({
              agentId: request.agentId,
              probability: 0.5,
              rationale: "frozen source signal considered",
            }),
            stopReason: "end",
          },
        };
      },
    };
    const baseCell = {
      trialId: "e".repeat(64),
      scenario,
      scenarioId: scenario.id,
      seed: 0,
      executionIndex: 0,
    };
    const options = {
      experimentId: "forecasting",
      referenceProvider: new FixtureReferenceProvider(),
      vocabularyRoot: "",
      provenance,
      adapter,
      evidenceByScenario: new Map([
        [
          scenario.id,
          [
            {
              item: {
                id: "market-signal",
                sourceName: "licensed source",
                sourceUrl: "https://example.com/signal",
                license: "CC-BY-4.0",
                publishedAt: "2026-01-01T00:00:00.000Z",
                observedAt: "2026-01-01T00:00:00.000Z",
                retrievedAt: "2026-01-02T00:00:00.000Z",
                frozenPath: "evidence.txt",
                sha256: "f".repeat(64),
                summary:
                  "Licensed source-market YES probability observed at t-24h.",
              },
              frozenText: "source_market_yes_probability: 0.5000\n",
            },
          ],
        ],
      ]),
    };
    await runModelForecastingTrial(
      { ...baseCell, condition: "baseline" },
      options,
    );
    const baselineRequests = [...requests];
    requests.length = 0;
    await runModelForecastingTrial(
      { ...baseCell, condition: "addressed-voluntary" },
      options,
    );
    expect(requests).toEqual(baselineRequests);
    const first = JSON.parse(requests[0] ?? "{}") as {
      forecastInstruction?: string;
      evidence?: { frozenText: string }[];
    };
    expect(first.forecastInstruction).toMatch(/local ResolutionDefinition/);
    expect(first.evidence?.[0]?.frozenText).toBe(
      "source_market_yes_probability: 0.5000\n",
    );
  });
});
