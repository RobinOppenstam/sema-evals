import type {
  ModelAgentAdapter,
  ModelCompletion,
  ModelPromptInput,
  SemanticReferenceProvider,
} from "@sema-evals/adapters";
import {
  type MatrixCell,
  type TrialEvent,
  type TrialProvenance,
  utf8Bytes,
} from "@sema-evals/core";

import { buildForecastObject, hydrationBytesFor } from "./agents.js";
import { aggregateForecasts } from "./aggregation.js";
import { conditionPolicy } from "./conditions.js";
import { executeForecastingCouncilMember } from "./model-executor.js";
import {
  buildAgentRegistry,
  buildCanonicalRegistry,
  type AgentRegistry,
} from "./registry.js";
import { brierScore, isUnitProbability, meanProbability } from "./scoring.js";
import type {
  ForecastObject,
  ForecastingCondition,
  ForecastingMetrics,
  ForecastingScenario,
  ForecastingTrialRecord,
} from "./schemas.js";

export interface ModelForecastingTrialOptions {
  experimentId: string;
  referenceProvider: SemanticReferenceProvider;
  vocabularyRoot: string;
  provenance: TrialProvenance;
  adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion>;
}

function combineUsage(
  results: Awaited<ReturnType<typeof executeForecastingCouncilMember>>[],
) {
  const values = results.flatMap((result) =>
    result.usage ? [result.usage] : [],
  );
  if (values.length === 0) return null;
  return {
    inputTokens: values.reduce((n, value) => n + value.inputTokens, 0),
    cachedInputTokensRead: values.reduce(
      (n, value) => n + value.cachedInputTokensRead,
      0,
    ),
    cachedInputTokensWritten: values.reduce(
      (n, value) => n + value.cachedInputTokensWritten,
      0,
    ),
    reasoningTokens: values.some((value) => value.reasoningTokens === null)
      ? null
      : values.reduce((n, value) => n + (value.reasoningTokens ?? 0), 0),
    outputTokens: values.reduce((n, value) => n + value.outputTokens, 0),
    attempts: values.reduce((n, value) => n + value.attempts, 0),
    retries: values.reduce((n, value) => n + value.retries, 0),
    errors: values.flatMap((value) => value.errors),
    latencyMs: values.reduce((n, value) => n + value.latencyMs, 0),
    stopReason: values.every(
      (value) => value.stopReason === values[0]?.stopReason,
    )
      ? (values[0]?.stopReason ?? null)
      : "mixed",
    costUsd: values.some((value) => value.costUsd === null)
      ? null
      : values.reduce((n, value) => n + (value.costUsd ?? 0), 0),
  };
}

function independentAverage(
  forecasts: readonly ForecastObject[],
  scenario: ForecastingScenario,
): number | null {
  const drifted = scenario.drift?.agentId;
  const values = forecasts
    .filter((forecast) => forecast.agentId !== drifted)
    .map((forecast) => forecast.probability);
  const mean = meanProbability(values);
  return mean;
}

/**
 * A real-model council replay. Model calls produce only forecast objects; all
 * reference construction, drift injection, aggregation, validation, outcome
 * scoring, and baselines remain deterministic and inspectable.
 */
export async function runModelForecastingTrial(
  cell: MatrixCell<ForecastingScenario, ForecastingCondition>,
  options: ModelForecastingTrialOptions,
): Promise<ForecastingTrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const { scenario, condition } = cell;
  const policy = conditionPolicy(condition);
  const canonicalRegistry = buildCanonicalRegistry(scenario);
  const registries = new Map<string, AgentRegistry>(
    scenario.agents.map((agent) => [
      agent.id,
      buildAgentRegistry(scenario, agent.id),
    ]),
  );
  const events: TrialEvent[] = [];
  let sequence = 0;
  if (scenario.drift)
    events.push({
      sequence: sequence++,
      type: "mutation",
      boundary: null,
      agent: scenario.drift.agentId,
      details: {
        handle: scenario.drift.handle,
        fieldPath: scenario.drift.fieldPath,
        before: scenario.drift.before,
        after: scenario.drift.after,
        registry: "forecaster",
      },
    });
  const hydrationBytes = hydrationBytesFor(scenario, registries);
  events.push({
    sequence: sequence++,
    type: "hydration",
    boundary: null,
    agent: "council",
    details: {
      hydrationBytes,
      resolver: options.referenceProvider.backend,
      agentCount: scenario.agents.length,
      forecastCutoff: scenario.question.historicalProvenance?.forecastCutoff,
    },
  });

  const allResults: Awaited<
    ReturnType<typeof executeForecastingCouncilMember>
  >[] = [];
  const callRound = async (
    round: 1 | 2,
    peers: readonly ForecastObject[],
  ): Promise<ForecastObject[]> => {
    const produced: ForecastObject[] = [];
    for (const agent of scenario.agents) {
      const registry = registries.get(agent.id);
      if (!registry) throw new Error(`Missing registry for ${agent.id}.`);
      const coordination = Object.fromEntries(
        scenario.coordinationHandles.map((handle) => [
          handle,
          registry.resolve(handle),
        ]),
      );
      const result = await executeForecastingCouncilMember(
        options.adapter,
        {
          schemaVersion: "forecasting-model-readiness-v1",
          ready: true,
          realQuestionsReady: true,
          historicalProvenanceValidated: true,
          evidencePackValidated: true,
          leakageAuditComplete: true,
          modelConfigured: true,
          blockReasons: [],
        },
        {
          agentId: agent.id,
          question: scenario.question.questionText,
          resolutionCriteria: scenario.question.resolutionCriteria,
          forecastCutoff:
            scenario.question.historicalProvenance?.forecastCutoff ?? "",
          round,
          peerForecasts: peers
            .filter((peer) => peer.agentId !== agent.id)
            .map((peer) => ({
              agentId: peer.agentId,
              probability: peer.probability,
            })),
          coordination,
        },
      );
      allResults.push(result);
      events.push({
        sequence: sequence++,
        type: "message",
        boundary: null,
        agent: agent.id,
        details: {
          round,
          modelStatus: result.status,
          parseFailure: result.failure,
          carriesReferences: policy.carriesReferences,
        },
      });
      if (!result.parsedOutput) continue;
      produced.push(
        await buildForecastObject({
          scenario,
          agentId: agent.id,
          round,
          probability: result.parsedOutput.probability,
          condition,
          registry,
          referenceProvider: options.referenceProvider,
        }),
      );
    }
    return produced;
  };
  const round1Forecasts = await callRound(1, []);
  const round2Forecasts = await callRound(2, round1Forecasts);
  const aggregation = await aggregateForecasts({
    forecasts: round2Forecasts,
    condition,
    canonicalRegistry,
    referenceProvider: options.referenceProvider,
  });
  const includedAgentIds = aggregation.included.map((item) => item.agentId);
  const excludedAgentIds = aggregation.excluded.map((item) => item.agentId);
  const aggregateProbability = aggregation.aggregateProbability;
  const independentAverageValue = independentAverage(round1Forecasts, scenario);
  const outcome = scenario.question.resolvedOutcome;
  const brierAggregate =
    aggregateProbability !== null && isUnitProbability(aggregateProbability)
      ? brierScore(aggregateProbability, outcome)
      : null;
  const driftedAgentId = scenario.drift?.agentId;
  const driftedForecastIncluded =
    driftedAgentId !== undefined && includedAgentIds.includes(driftedAgentId);
  events.push({
    sequence: sequence++,
    type: "verification",
    boundary: null,
    agent: "aggregator",
    details: {
      enforced: policy.enforces,
      referencesChecked: aggregation.referencesChecked,
      referencesMatched: aggregation.referencesMatched,
      referencesMismatched: aggregation.referencesMismatched,
      driftDetected: aggregation.driftDetected,
      includedAgentIds,
      excludedAgentIds,
    },
  });
  events.push({
    sequence: sequence++,
    type: "completion",
    boundary: null,
    agent: "aggregator",
    details: {
      aggregateProbability,
      brierAggregate,
      brierMarketPrior: brierScore(scenario.question.marketPrior, outcome),
      brierIndependentAverage:
        independentAverageValue === null
          ? null
          : brierScore(independentAverageValue, outcome),
      modelMembersCompleted: round2Forecasts.length,
    },
  });
  const usage = combineUsage(allResults);
  const metrics: ForecastingMetrics = {
    driftInjected: scenario.drift !== null,
    referencesCarried: policy.carriesReferences,
    verificationPerformed: policy.verifies,
    referencesChecked: aggregation.referencesChecked,
    referencesMatched: aggregation.referencesMatched,
    referencesMismatched: aggregation.referencesMismatched,
    driftDetected: aggregation.driftDetected,
    forecastsSubmitted: round2Forecasts.length,
    forecastsIncluded: includedAgentIds.length,
    forecastsExcluded: excludedAgentIds.length,
    driftedForecastIncluded,
    corruptedAggregation:
      scenario.drift !== null &&
      driftedForecastIncluded &&
      !aggregation.driftDetected,
    correctExclusion:
      scenario.drift !== null &&
      driftedAgentId !== undefined &&
      excludedAgentIds.includes(driftedAgentId),
    falseExclusion: scenario.drift === null && excludedAgentIds.length > 0,
    aggregateProbability,
    marketPrior: scenario.question.marketPrior,
    independentAverage: independentAverageValue,
    brierAggregate,
    brierMarketPrior: brierScore(scenario.question.marketPrior, outcome),
    brierIndependentAverage:
      independentAverageValue === null
        ? null
        : brierScore(independentAverageValue, outcome),
    outcome,
    exclusionReasons: [...aggregation.exclusionReasons.values()],
    wireBytes: utf8Bytes(round1Forecasts) + utf8Bytes(round2Forecasts),
    hydrationBytes,
    totalSemanticBytes:
      utf8Bytes(round1Forecasts) + utf8Bytes(round2Forecasts) + hydrationBytes,
    elapsedMs: performance.now() - started,
  };
  const transcriptEntries = allResults.flatMap((result, callIndex) =>
    (result.transcript?.entries ?? []).map((entry) => ({
      ...entry,
      index: callIndex * 10_000 + entry.index,
    })),
  );
  return {
    trialId: cell.trialId,
    experimentId: options.experimentId,
    scenarioId: cell.scenarioId,
    condition,
    seed: cell.seed,
    executionIndex: cell.executionIndex,
    startedAt,
    completedAt: new Date().toISOString(),
    driftInjected: scenario.drift !== null,
    question: scenario.question,
    leakageAudit: scenario.leakageAudit,
    round1Forecasts,
    round2Forecasts,
    includedAgentIds,
    excludedAgentIds,
    events,
    metrics,
    provenance: options.provenance,
    usage,
    transcript: { entries: transcriptEntries },
  };
}
