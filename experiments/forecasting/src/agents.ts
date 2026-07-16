import { type SemanticReferenceProvider } from "@sema-evals/adapters";
import { utf8Bytes } from "@sema-evals/core";

import { conditionPolicy } from "./conditions.js";
import type { AgentRegistry } from "./registry.js";
import type {
  ForecastObject,
  ForecastingCondition,
  ForecastingScenario,
  SemanticReference,
} from "./schemas.js";

/**
 * Resolves each coordination handle from a registry and produces a
 * content-addressed reference through the shared reference provider — the same
 * canonicalization pathway the other experiments use.
 */
export async function buildCitedReferences(
  scenario: ForecastingScenario,
  registry: AgentRegistry,
  referenceProvider: SemanticReferenceProvider,
): Promise<SemanticReference[]> {
  const references: SemanticReference[] = [];
  for (const handle of scenario.coordinationHandles) {
    const definition = registry.resolve(handle);
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

/**
 * Builds one scripted forecast object for a given round. Baseline cites handle
 * names only; addressed conditions attach content-addressed references from
 * the agent's own registry.
 */
export async function buildForecastObject(options: {
  scenario: ForecastingScenario;
  agentId: string;
  round: 1 | 2;
  probability: number;
  condition: ForecastingCondition;
  registry: AgentRegistry;
  referenceProvider: SemanticReferenceProvider;
}): Promise<ForecastObject> {
  const policy = conditionPolicy(options.condition);
  let citedReferences: SemanticReference[] = [];
  if (policy.carriesReferences) {
    citedReferences = await buildCitedReferences(
      options.scenario,
      options.registry,
      options.referenceProvider,
    );
  }
  return {
    agentId: options.agentId,
    round: options.round,
    probability: options.probability,
    citedHandles: [...options.scenario.coordinationHandles],
    citedReferences,
  };
}

/**
 * Bytes the aggregator (and each agent) hydrates from registries to resolve
 * coordination handles. Summed across all agent registries for the trial.
 */
export function hydrationBytesFor(
  scenario: ForecastingScenario,
  registries: ReadonlyMap<string, AgentRegistry>,
): number {
  let total = 0;
  for (const registry of registries.values()) {
    const resolved: Record<string, unknown> = {};
    for (const handle of scenario.coordinationHandles) {
      resolved[handle] = registry.resolve(handle);
    }
    total += utf8Bytes(resolved);
  }
  return total;
}
