import { fingerprint } from "@sema-evals/core";

import type { ForecastingScenario } from "./schemas.js";

/**
 * A single forecaster's coordination-term registry: a handle -> definition map.
 * Each agent resolves coordination handles against ITS OWN registry, so a
 * mutated definition on exactly one agent is the controlled council drift this
 * experiment injects. This is an in-repo model of a Sema registry; no external
 * service.
 */
export class AgentRegistry {
  private readonly definitions: Map<string, Record<string, unknown>>;

  public constructor(entries: Iterable<[string, Record<string, unknown>]>) {
    this.definitions = new Map(entries);
  }

  public has(handle: string): boolean {
    return this.definitions.has(handle);
  }

  public resolve(handle: string): Record<string, unknown> {
    const definition = this.definitions.get(handle);
    if (!definition) {
      throw new Error(`Registry does not contain handle ${handle}.`);
    }
    return definition;
  }

  public handles(): string[] {
    return [...this.definitions.keys()];
  }
}

/** The canonical registry is always the scenario's vocabulary (no mutation). */
export function buildCanonicalRegistry(
  scenario: ForecastingScenario,
): AgentRegistry {
  return new AgentRegistry(
    scenario.patterns.map((pattern) => [pattern.handle, pattern.definition]),
  );
}

/**
 * Builds one forecaster's registry. For a drift scenario, exactly the drifted
 * agent's registry holds the mutated definition for the drifted handle; every
 * other agent (and every other handle) matches the canonical vocabulary. For a
 * no-drift control every agent equals the canonical registry.
 */
export function buildAgentRegistry(
  scenario: ForecastingScenario,
  agentId: string,
): AgentRegistry {
  const entries = scenario.patterns.map(
    (pattern): [string, Record<string, unknown>] => {
      if (
        scenario.drift &&
        scenario.drift.agentId === agentId &&
        pattern.handle === scenario.drift.handle
      ) {
        return [pattern.handle, scenario.drift.mutatedDefinition];
      }
      return [pattern.handle, pattern.definition];
    },
  );
  return new AgentRegistry(entries);
}

/**
 * Verifies that a scenario's drift injection is well-formed and isolated:
 * exactly one agent differs from the canonical registry, and that agent differs
 * on exactly the drifted handle (or every agent is identical for a no-drift
 * control). Callers use this as a guardrail so a fixture typo cannot silently
 * widen or void the drift.
 */
export function assertDriftIsolation(scenario: ForecastingScenario): void {
  const canonical = buildCanonicalRegistry(scenario);
  const driftedAgents: string[] = [];
  const changedByAgent = new Map<string, string[]>();

  for (const agent of scenario.agents) {
    const registry = buildAgentRegistry(scenario, agent.id);
    const changed: string[] = [];
    for (const handle of canonical.handles()) {
      if (
        fingerprint(canonical.resolve(handle)) !==
        fingerprint(registry.resolve(handle))
      ) {
        changed.push(handle);
      }
    }
    if (changed.length > 0) {
      driftedAgents.push(agent.id);
      changedByAgent.set(agent.id, changed);
    }
  }

  if (scenario.drift === null) {
    if (driftedAgents.length > 0) {
      throw new Error(
        `Scenario ${scenario.id} is a no-drift control but registries differ for ${driftedAgents.join(", ")}.`,
      );
    }
    return;
  }

  if (
    driftedAgents.length !== 1 ||
    driftedAgents[0] !== scenario.drift.agentId
  ) {
    throw new Error(
      `Scenario ${scenario.id} drift is not isolated to agent ${scenario.drift.agentId}; drifted agents: ${driftedAgents.join(", ") || "none"}.`,
    );
  }

  const changed = changedByAgent.get(scenario.drift.agentId) ?? [];
  if (changed.length !== 1 || changed[0] !== scenario.drift.handle) {
    throw new Error(
      `Scenario ${scenario.id} drift is not isolated to ${scenario.drift.handle}; changed handles for ${scenario.drift.agentId}: ${changed.join(", ") || "none"}.`,
    );
  }
}
