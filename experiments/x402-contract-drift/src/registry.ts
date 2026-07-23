import { fingerprint } from "@sema-evals/core";

import type { X402DriftScenario } from "./schemas.js";

function valueAtPath(
  definition: Record<string, unknown>,
  fieldPath: string,
): unknown {
  let current: unknown = definition;
  for (const segment of fieldPath.split(".")) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      throw new Error(`Definition does not contain field path ${fieldPath}.`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * A single party's payment-term registry: a handle -> definition map. Each
 * party resolves acceptance-contract handles against ITS OWN registry, so a
 * mutated definition on the payer side is exactly the cross-party drift this
 * experiment injects. This is an in-repo model of a Sema registry; no external
 * service.
 */
export class PartyRegistry {
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

/** The seller's registry is always the scenario's canonical vocabulary. */
export function buildSellerRegistry(
  scenario: X402DriftScenario,
): PartyRegistry {
  return new PartyRegistry(
    scenario.patterns.map((pattern) => [pattern.handle, pattern.definition]),
  );
}

/**
 * The payer's registry is the canonical vocabulary with, for a drift scenario,
 * exactly one handle's definition replaced by its mutated variant. This is the
 * controlled cross-party registry drift: identical everywhere except the one
 * drifted handle. For a no-drift control the payer registry equals the seller
 * registry.
 */
export function buildPayerRegistry(scenario: X402DriftScenario): PartyRegistry {
  const entries = scenario.patterns.map(
    (pattern): [string, Record<string, unknown>] => {
      if (scenario.drift && pattern.handle === scenario.drift.handle) {
        return [pattern.handle, scenario.drift.mutatedDefinition];
      }
      return [pattern.handle, pattern.definition];
    },
  );
  return new PartyRegistry(entries);
}

/**
 * Verifies that a scenario's drift injection is well-formed and isolated: the
 * payer registry must differ from the seller registry on exactly the drifted
 * handle and nowhere else (or be identical for a no-drift control). Callers use
 * this as a guardrail so a fixture typo cannot silently widen or void the
 * drift.
 */
export function assertDriftIsolation(scenario: X402DriftScenario): void {
  const seller = buildSellerRegistry(scenario);
  const payer = buildPayerRegistry(scenario);
  const changed: string[] = [];
  for (const handle of seller.handles()) {
    if (
      fingerprint(seller.resolve(handle)) !== fingerprint(payer.resolve(handle))
    ) {
      changed.push(handle);
    }
  }
  if (scenario.drift === null) {
    if (changed.length > 0) {
      throw new Error(
        `Scenario ${scenario.id} is a no-drift control but the payer registry differs on ${changed.join(", ")}.`,
      );
    }
    return;
  }
  if (changed.length !== 1 || changed[0] !== scenario.drift.handle) {
    throw new Error(
      `Scenario ${scenario.id} drift is not isolated to ${scenario.drift.handle}; changed handles: ${changed.join(", ") || "none"}.`,
    );
  }
  const canonical = seller.resolve(scenario.drift.handle);
  const mutated = payer.resolve(scenario.drift.handle);
  if (
    fingerprint(valueAtPath(canonical, scenario.drift.fieldPath)) !==
    fingerprint(scenario.drift.before)
  ) {
    throw new Error(
      `Scenario ${scenario.id} canonical ${scenario.drift.fieldPath} does not match drift.before.`,
    );
  }
  if (
    fingerprint(valueAtPath(mutated, scenario.drift.fieldPath)) !==
    fingerprint(scenario.drift.after)
  ) {
    throw new Error(
      `Scenario ${scenario.id} mutated ${scenario.drift.fieldPath} does not match drift.after.`,
    );
  }
}
