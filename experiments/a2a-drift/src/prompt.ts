import { stableJson } from "@sema-evals/core";

import { conditionPolicy } from "./conditions.js";
import type { VerificationResult } from "./middleware.js";
import type { AgentRegistry } from "./registry.js";
import type {
  A2aDriftCondition,
  A2aDriftScenario,
  AcceptanceContract,
} from "./schemas.js";

/**
 * Canonical, byte-stable pretty rendering of a JSON value. Keys are sorted so
 * the block is digest-identical across runs and conditions given the same
 * logical content.
 */
export function stableDefinitionText(value: unknown): string {
  return JSON.stringify(JSON.parse(stableJson(value)), null, 2);
}

/** Worker-resolved definitions for the acceptance handles, key-sorted. */
export function workerDefinitionsFor(
  scenario: A2aDriftScenario,
  workerRegistry: AgentRegistry,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const handle of [...scenario.acceptanceHandles].sort()) {
    resolved[handle] = workerRegistry.resolve(handle);
  }
  return resolved;
}

export interface WorkerPromptParams {
  condition: A2aDriftCondition;
  scenario: A2aDriftScenario;
  workerRegistry: AgentRegistry;
  contract: AcceptanceContract | undefined;
  verification: VerificationResult | undefined;
}

/**
 * Builds the user message for the model worker. The task TextPart is always
 * present. Worker-resolved definitions are always included (the worker always
 * hydrates to do the work). Advertised conditions additionally attach the
 * acceptance contract and the deterministic middleware verification report.
 * Rendering is byte-stable for a given (scenario, condition, registries,
 * verification) so prompt digests and tests can pin the construction.
 */
export function buildWorkerUserMessage(params: WorkerPromptParams): string {
  const policy = conditionPolicy(params.condition);
  const definitions = workerDefinitionsFor(
    params.scenario,
    params.workerRegistry,
  );

  const sections: string[] = [
    `## Task\n${params.scenario.task}`,
    `## Requested handles\n${stableDefinitionText(params.scenario.acceptanceHandles)}`,
    `## Worker registry definitions\n${stableDefinitionText(definitions)}`,
  ];

  if (policy.carriesReferences && params.contract) {
    sections.push(
      `## Acceptance contract\n${stableDefinitionText(params.contract)}`,
    );
  }

  if (policy.verifies && params.verification) {
    sections.push(
      `## Verification report\n${stableDefinitionText({
        referencesChecked: params.verification.referencesChecked,
        referencesMatched: params.verification.referencesMatched,
        referencesMismatched: params.verification.referencesMismatched,
        driftDetected: params.verification.driftDetected,
        checks: params.verification.checks,
      })}`,
    );
  }

  return sections.join("\n\n");
}
