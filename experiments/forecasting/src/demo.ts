import { type SemanticReferenceProvider } from "@sema-evals/adapters";
import {
  type MatrixCell,
  type TrialEvent,
  type TrialProvenance,
  utf8Bytes,
} from "@sema-evals/core";

import { buildForecastObject, hydrationBytesFor } from "./agents.js";
import { aggregateForecasts, normalizeProbability } from "./aggregation.js";
import { conditionPolicy } from "./conditions.js";
import {
  assertDriftIsolation,
  buildAgentRegistry,
  buildCanonicalRegistry,
  type AgentRegistry,
} from "./registry.js";
import {
  forecastingTrialRecordSchema,
  type ForecastObject,
  type ForecastingCondition,
  type ForecastingMetrics,
  type ForecastingScenario,
  type ForecastingTrialRecord,
} from "./schemas.js";
import { brierScore, isUnitProbability, meanProbability } from "./scoring.js";

/**
 * Mandatory independent-agent baseline: round-1 mean over drift-free members,
 * each normalized by that agent's ProbabilityFormat onto the unit interval.
 */
function independentAverageFor(scenario: ForecastingScenario): number {
  const driftFree = scenario.agents.filter(
    (agent) => scenario.drift === null || agent.id !== scenario.drift.agentId,
  );
  const unitValues = driftFree.map((agent) => {
    const registry = buildAgentRegistry(scenario, agent.id);
    const format = registry.resolve("ProbabilityFormat");
    return normalizeProbability(agent.round1Probability, format);
  });
  const mean = meanProbability(unitValues);
  if (mean === null) {
    throw new Error(`Scenario ${scenario.id} has no drift-free agents.`);
  }
  return mean;
}

export interface ForecastingTrialOptions {
  experimentId: string;
  referenceProvider: SemanticReferenceProvider;
  vocabularyRoot: string;
  provenance: TrialProvenance;
}

/**
 * Runs one deterministic forecasting-council trial: N scripted forecasters
 * produce round-1 independent forecasts, exchange structured forecast objects,
 * revise in round 2, then the aggregator applies the condition's inclusion and
 * normalization rules. Controlled registry drift is injected into exactly one
 * agent's registry. No model call; metrics are exact and test-checked. `usage`
 * and `transcript` are null, as in the deterministic siblings.
 */
export async function runForecastingTrial(
  cell: MatrixCell<ForecastingScenario, ForecastingCondition>,
  options: ForecastingTrialOptions,
): Promise<ForecastingTrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const scenario = cell.scenario;
  const condition = cell.condition;
  const policy = conditionPolicy(condition);
  const driftInjected = scenario.drift !== null;

  assertDriftIsolation(scenario);

  const canonicalRegistry = buildCanonicalRegistry(scenario);
  const agentRegistries = new Map<string, AgentRegistry>();
  for (const agent of scenario.agents) {
    agentRegistries.set(agent.id, buildAgentRegistry(scenario, agent.id));
  }

  const events: TrialEvent[] = [];
  let sequence = 0;

  if (scenario.drift) {
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
  }

  const hydrationBytes = hydrationBytesFor(scenario, agentRegistries);
  events.push({
    sequence: sequence++,
    type: "hydration",
    boundary: null,
    agent: "council",
    details: {
      hydrationBytes,
      resolver: options.referenceProvider.backend,
      handles: scenario.coordinationHandles,
      agentCount: scenario.agents.length,
    },
  });

  // Round 1: independent forecasts.
  const round1Forecasts: ForecastObject[] = [];
  for (const agent of scenario.agents) {
    const registry = agentRegistries.get(agent.id);
    if (!registry) {
      throw new Error(`Missing registry for ${agent.id}.`);
    }
    const forecast = await buildForecastObject({
      scenario,
      agentId: agent.id,
      round: 1,
      probability: agent.round1Probability,
      condition,
      registry,
      referenceProvider: options.referenceProvider,
    });
    round1Forecasts.push(forecast);
    events.push({
      sequence: sequence++,
      type: "message",
      boundary: null,
      agent: agent.id,
      details: {
        round: 1,
        probability: forecast.probability,
        carriesReferences: policy.carriesReferences,
        citedHandles: forecast.citedHandles,
      },
    });
  }

  // Round 2: each agent "sees" peers' round-1 objects and revises per script.
  const round2Forecasts: ForecastObject[] = [];
  for (const agent of scenario.agents) {
    const registry = agentRegistries.get(agent.id);
    if (!registry) {
      throw new Error(`Missing registry for ${agent.id}.`);
    }
    const forecast = await buildForecastObject({
      scenario,
      agentId: agent.id,
      round: 2,
      probability: agent.round2Probability,
      condition,
      registry,
      referenceProvider: options.referenceProvider,
    });
    round2Forecasts.push(forecast);
    events.push({
      sequence: sequence++,
      type: "message",
      boundary: null,
      agent: agent.id,
      details: {
        round: 2,
        probability: forecast.probability,
        peersSeen: round1Forecasts
          .filter((peer) => peer.agentId !== agent.id)
          .map((peer) => peer.agentId),
        carriesReferences: policy.carriesReferences,
      },
    });
  }

  const aggregation = await aggregateForecasts({
    forecasts: round2Forecasts,
    condition,
    canonicalRegistry,
    referenceProvider: options.referenceProvider,
  });

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
      included: aggregation.included.map((f) => f.agentId),
      excluded: aggregation.excluded.map((f) => f.agentId),
      verdict: policy.enforces
        ? aggregation.excluded.length > 0
          ? "EXCLUDE"
          : "INCLUDE_ALL"
        : aggregation.driftDetected
          ? "SURFACE_AND_AGGREGATE_ALL"
          : "AGGREGATE_ALL",
    },
  });

  const includedAgentIds = aggregation.included.map((f) => f.agentId);
  const excludedAgentIds = aggregation.excluded.map((f) => f.agentId);
  const driftedAgentId = scenario.drift?.agentId ?? null;
  const driftedForecastIncluded =
    driftedAgentId !== null && includedAgentIds.includes(driftedAgentId);

  const aggregateProbability = aggregation.aggregateProbability;
  const independentAverage = independentAverageFor(scenario);
  const outcome = scenario.question.resolvedOutcome;
  const marketPrior = scenario.question.marketPrior;

  const brierAggregate =
    aggregateProbability === null || !isUnitProbability(aggregateProbability)
      ? null
      : brierScore(aggregateProbability, outcome);
  const brierMarketPrior = brierScore(marketPrior, outcome);
  const brierIndependentAverage = brierScore(independentAverage, outcome);

  const exclusionReasons = [...aggregation.exclusionReasons.values()];
  const wireBytes = utf8Bytes(round1Forecasts) + utf8Bytes(round2Forecasts);

  events.push({
    sequence: sequence++,
    type: "completion",
    boundary: null,
    agent: "aggregator",
    details: {
      aggregateProbability,
      forecastsIncluded: includedAgentIds.length,
      forecastsExcluded: excludedAgentIds.length,
      brierAggregate,
      brierMarketPrior,
      brierIndependentAverage,
    },
  });

  const metrics: ForecastingMetrics = {
    driftInjected,
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
      driftInjected && driftedForecastIncluded && !aggregation.driftDetected,
    correctExclusion:
      driftInjected &&
      driftedAgentId !== null &&
      excludedAgentIds.includes(driftedAgentId),
    falseExclusion: !driftInjected && excludedAgentIds.length > 0,
    aggregateProbability,
    marketPrior,
    independentAverage,
    brierAggregate,
    brierMarketPrior,
    brierIndependentAverage,
    outcome,
    exclusionReasons,
    wireBytes,
    hydrationBytes,
    totalSemanticBytes: wireBytes + hydrationBytes,
    elapsedMs: performance.now() - started,
  };

  const record: ForecastingTrialRecord = {
    trialId: cell.trialId,
    experimentId: options.experimentId,
    scenarioId: cell.scenarioId,
    condition,
    seed: cell.seed,
    executionIndex: cell.executionIndex,
    startedAt,
    completedAt: new Date().toISOString(),
    driftInjected,
    question: scenario.question,
    leakageAudit: scenario.leakageAudit,
    round1Forecasts,
    round2Forecasts,
    includedAgentIds,
    excludedAgentIds,
    events,
    metrics,
    provenance: options.provenance,
    usage: null,
    transcript: null,
  };

  return forecastingTrialRecordSchema.parse(record);
}
