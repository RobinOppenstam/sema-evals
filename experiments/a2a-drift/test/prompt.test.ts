import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import { fingerprint } from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import { loadFixtureFile } from "../src/fixtures.js";
import {
  applyEnforcement,
  verifyAcceptanceContract,
} from "../src/middleware.js";
import { buildWorkerUserMessage } from "../src/prompt.js";
import {
  buildRequesterRegistry,
  buildWorkerRegistry,
} from "../src/registry.js";
import {
  buildRequiredReferences,
  buildTaskMessage,
  extractAcceptanceContract,
} from "../src/agents.js";
import type { A2aDriftCondition, A2aDriftScenario } from "../src/schemas.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/scenarios.yaml",
);

async function scenarioById(id: string): Promise<A2aDriftScenario> {
  const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
  const scenario = fixtureSet.scenarios.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Expected scenario ${id}.`);
  }
  return scenario;
}

describe("buildWorkerUserMessage", () => {
  it("is digest-stable across repeated construction for each condition", async () => {
    const scenario = await scenarioById("settlement-drift");
    const provider = new FixtureReferenceProvider();
    const requesterRegistry = buildRequesterRegistry(scenario);
    const workerRegistry = buildWorkerRegistry(scenario);
    const references = await buildRequiredReferences(
      scenario,
      requesterRegistry,
      provider,
    );

    for (const condition of [
      "baseline",
      "advertised-voluntary",
      "advertised-enforced",
    ] as const satisfies readonly A2aDriftCondition[]) {
      const { message } = buildTaskMessage(scenario, condition, references);
      const contract = extractAcceptanceContract(message);
      const verification =
        contract !== undefined
          ? await verifyAcceptanceContract(contract, workerRegistry, provider)
          : undefined;

      const first = buildWorkerUserMessage({
        condition,
        scenario,
        workerRegistry,
        contract,
        verification,
      });
      const second = buildWorkerUserMessage({
        condition,
        scenario,
        workerRegistry,
        contract,
        verification,
      });

      expect(first).toBe(second);
      expect(fingerprint(first)).toBe(fingerprint(second));
      expect(first).toContain("## Task\n");
      expect(first).toContain(scenario.task);
      expect(first).toContain("## Worker registry definitions\n");

      if (condition === "baseline") {
        expect(first).not.toContain("## Acceptance contract\n");
        expect(first).not.toContain("## Verification report\n");
      } else {
        expect(first).toContain("## Acceptance contract\n");
        expect(first).toContain("## Verification report\n");
        expect(verification?.driftDetected).toBe(true);
      }
    }
  });

  it("includes a clean verification report for no-drift advertised trials", async () => {
    const scenario = await scenarioById("settlement-clean");
    const provider = new FixtureReferenceProvider();
    const requesterRegistry = buildRequesterRegistry(scenario);
    const workerRegistry = buildWorkerRegistry(scenario);
    const references = await buildRequiredReferences(
      scenario,
      requesterRegistry,
      provider,
    );
    const condition: A2aDriftCondition = "advertised-voluntary";
    const { message } = buildTaskMessage(scenario, condition, references);
    const contract = extractAcceptanceContract(message);
    if (!contract) {
      throw new Error("Expected acceptance contract.");
    }
    const verification = await verifyAcceptanceContract(
      contract,
      workerRegistry,
      provider,
    );
    expect(verification.driftDetected).toBe(false);
    expect(applyEnforcement(verification, contract.enforcement).halted).toBe(
      false,
    );

    const prompt = buildWorkerUserMessage({
      condition,
      scenario,
      workerRegistry,
      contract,
      verification,
    });
    expect(prompt).toContain('"driftDetected": false');
  });
});
