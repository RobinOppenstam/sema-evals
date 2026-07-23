import {
  createModelProvider,
  type ModelAgentAdapter,
  type ModelCompletion,
  type ModelPromptInput,
  type ModelProviderConfig,
} from "@sema-evals/adapters";
import {
  fingerprint,
  transcriptSchema,
  usageTelemetrySchema,
} from "@sema-evals/core";
import { z } from "zod";

export const forecastingModelReadinessGateSchema = z
  .object({
    schemaVersion: z.literal("forecasting-model-readiness-v1"),
    ready: z.boolean(),
    realQuestionsReady: z.boolean(),
    historicalProvenanceValidated: z.boolean(),
    evidencePackValidated: z.boolean(),
    leakageAuditComplete: z.boolean(),
    modelConfigured: z.boolean(),
    blockReasons: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((gate, context) => {
    const expected = [
      ...(gate.realQuestionsReady
        ? []
        : ["real-polymarket-question-set-not-acquired"]),
      ...(gate.historicalProvenanceValidated
        ? []
        : ["historical-provenance-or-license-not-validated"]),
      ...(gate.evidencePackValidated
        ? []
        : ["evidence-pack-or-no-evidence-protocol-not-validated"]),
      ...(gate.leakageAuditComplete
        ? []
        : ["model-specific-leakage-audit-not-complete"]),
      ...(gate.modelConfigured ? [] : ["model-provider-not-configured"]),
    ];
    if (
      gate.ready !== (expected.length === 0) ||
      JSON.stringify(gate.blockReasons) !== JSON.stringify(expected)
    )
      context.addIssue({
        code: "custom",
        path: ["blockReasons"],
        message: "readiness prerequisites are inconsistent",
      });
  });

export const forecastingCouncilOutputSchema = z.object({
  agentId: z.string().min(1),
  probability: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

export const forecastingModelExecutorResultSchema = z.object({
  schemaVersion: z.literal("forecasting-model-executor-v1"),
  status: z.enum([
    "completed",
    "refused",
    "truncated",
    "error",
    "blocked",
    "malformed-output",
  ]),
  requestFingerprint: z.string().length(64),
  executorFingerprint: z.string().length(64),
  rawOutput: z.string(),
  parsedOutput: forecastingCouncilOutputSchema.nullable(),
  transcript: transcriptSchema.nullable(),
  usage: usageTelemetrySchema.nullable(),
  failure: z.object({ stage: z.string(), message: z.string() }).nullable(),
});

export function createForecastingModelProvider(config: ModelProviderConfig) {
  return createModelProvider(config);
}

export async function executeForecastingCouncilMember(
  adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion>,
  gateInput: z.infer<typeof forecastingModelReadinessGateSchema>,
  request: {
    agentId: string;
    question: string;
    resolutionCriteria: string;
    forecastCutoff: string;
    evidence?: readonly { id: string; summary: string }[];
    round?: 1 | 2;
    peerForecasts?: readonly { agentId: string; probability: number }[];
    coordination?: Readonly<Record<string, unknown>>;
  },
) {
  const gate = forecastingModelReadinessGateSchema.parse(gateInput);
  const requestFingerprint = fingerprint(request);
  const executorFingerprint = fingerprint({
    version: "forecasting-model-executor-v1",
    adapter: adapter.descriptor,
  });
  if (!gate.ready)
    return forecastingModelExecutorResultSchema.parse({
      schemaVersion: "forecasting-model-executor-v1",
      status: "blocked",
      requestFingerprint,
      executorFingerprint,
      rawOutput: "",
      parsedOutput: null,
      transcript: null,
      usage: null,
      failure: { stage: "readiness", message: gate.blockReasons.join("; ") },
    });
  try {
    const response = await adapter.invoke({
      messages: [{ role: "user", content: JSON.stringify(request) }],
    });
    let parsedOutput: unknown = null;
    try {
      parsedOutput = JSON.parse(response.output.text);
    } catch {
      parsedOutput = null;
    }
    const parsed = forecastingCouncilOutputSchema.safeParse(parsedOutput);
    const outputMatchesAgent =
      parsed.success && parsed.data.agentId === request.agentId;
    return forecastingModelExecutorResultSchema.parse({
      schemaVersion: "forecasting-model-executor-v1",
      status:
        response.output.status === "completed" &&
        (!parsed.success || !outputMatchesAgent)
          ? "malformed-output"
          : response.output.status,
      requestFingerprint,
      executorFingerprint,
      rawOutput: response.output.text,
      parsedOutput: outputMatchesAgent ? parsed.data : null,
      transcript: response.transcript,
      usage: response.usage,
      failure:
        response.output.status === "completed" &&
        (!parsed.success || !outputMatchesAgent)
          ? {
              stage: "parse",
              message: "invalid structured forecast or agent id",
            }
          : null,
    });
  } catch (error) {
    return forecastingModelExecutorResultSchema.parse({
      schemaVersion: "forecasting-model-executor-v1",
      status: "error",
      requestFingerprint,
      executorFingerprint,
      rawOutput: "",
      parsedOutput: null,
      transcript: null,
      usage: null,
      failure: {
        stage: "invoke",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export async function executeForecastingCouncil(
  adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion>,
  gate: z.infer<typeof forecastingModelReadinessGateSchema>,
  requests: Parameters<typeof executeForecastingCouncilMember>[2][],
) {
  const members = await Promise.all(
    requests.map((request) =>
      executeForecastingCouncilMember(adapter, gate, request),
    ),
  );
  const probabilities = members.flatMap((member) =>
    member.parsedOutput ? [member.parsedOutput.probability] : [],
  );
  return {
    status:
      probabilities.length === members.length
        ? ("completed" as const)
        : ("malformed-output" as const),
    members,
    aggregateProbability:
      probabilities.length === members.length
        ? probabilities.reduce((sum, value) => sum + value, 0) /
          probabilities.length
        : null,
    councilFingerprint: fingerprint({ requests, members }),
  };
}
