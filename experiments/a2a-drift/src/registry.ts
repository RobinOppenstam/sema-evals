import { fingerprint } from "@sema-evals/core";

import type { A2aDriftScenario } from "./schemas.js";

/**
 * A single agent's semantic registry: a handle -> definition map. Each agent
 * resolves acceptance-contract handles against ITS OWN registry, so a mutated
 * definition on the worker side is exactly the cross-agent drift Phase 3
 * injects. This is an in-repo model of a Sema registry; no external service.
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

/** The requester's registry is always the scenario's canonical vocabulary. */
export function buildRequesterRegistry(
  scenario: A2aDriftScenario,
): AgentRegistry {
  return new AgentRegistry(
    scenario.patterns.map((pattern) => [pattern.handle, pattern.definition]),
  );
}

/**
 * The worker's registry is the canonical vocabulary with, for a drift scenario,
 * exactly one handle's definition replaced by its mutated variant. This is the
 * controlled cross-agent registry drift: identical everywhere except the one
 * drifted handle. For a no-drift control the worker registry equals the
 * requester registry.
 */
export function buildWorkerRegistry(scenario: A2aDriftScenario): AgentRegistry {
  const entries = scenario.patterns.map(
    (pattern): [string, Record<string, unknown>] => {
      if (scenario.drift && pattern.handle === scenario.drift.handle) {
        return [pattern.handle, scenario.drift.mutatedDefinition];
      }
      return [pattern.handle, pattern.definition];
    },
  );
  return new AgentRegistry(entries);
}

/**
 * Verifies that a scenario's drift injection is well-formed and isolated: the
 * worker registry must differ from the requester registry on exactly the
 * drifted handle and nowhere else (or be identical for a no-drift control).
 * Callers use this as a guardrail so a fixture typo cannot silently widen or
 * void the drift.
 */
export function assertDriftIsolation(scenario: A2aDriftScenario): void {
  const requester = buildRequesterRegistry(scenario);
  const worker = buildWorkerRegistry(scenario);
  const changed: string[] = [];
  for (const handle of requester.handles()) {
    if (
      fingerprint(requester.resolve(handle)) !==
      fingerprint(worker.resolve(handle))
    ) {
      changed.push(handle);
    }
  }
  if (scenario.drift === null) {
    if (changed.length > 0) {
      throw new Error(
        `Scenario ${scenario.id} is a no-drift control but the worker registry differs on ${changed.join(", ")}.`,
      );
    }
    return;
  }
  if (changed.length !== 1 || changed[0] !== scenario.drift.handle) {
    throw new Error(
      `Scenario ${scenario.id} drift is not isolated to ${scenario.drift.handle}; changed handles: ${changed.join(", ") || "none"}.`,
    );
  }
}
