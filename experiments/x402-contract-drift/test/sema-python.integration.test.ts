import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SemaPythonReferenceProvider } from "@sema-evals/adapters";
import { describe, expect, it } from "vitest";

import { loadFixtureFile } from "../src/fixtures.js";
import { buildPayerRegistry, buildSellerRegistry } from "../src/registry.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/scenarios.yaml",
);
const integration = process.env.SEMA_PYTHON ? describe : describe.skip;

integration("x402 fixtures with official semahash Python", () => {
  it("gives every declared semantic drift a different Sema address", async () => {
    const pythonCommand = process.env.SEMA_PYTHON;
    if (!pythonCommand) {
      throw new Error("SEMA_PYTHON is required for this integration test.");
    }
    const provider = new SemaPythonReferenceProvider({ pythonCommand });
    const metadata = await provider.metadata();
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);

    expect(metadata).toMatchObject({
      backend: "semahash-python-api",
      canonicalizationVersion: "v2",
      officialSema: true,
    });

    for (const scenario of fixtureSet.scenarios) {
      if (scenario.drift === null) {
        continue;
      }
      const seller = buildSellerRegistry(scenario);
      const payer = buildPayerRegistry(scenario);
      const canonical = await provider.reference(
        scenario.drift.handle,
        seller.resolve(scenario.drift.handle),
      );
      const mutated = await provider.reference(
        scenario.drift.handle,
        payer.resolve(scenario.drift.handle),
      );
      expect(
        mutated.full,
        `${scenario.id} collapsed to the canonical Sema address`,
      ).not.toBe(canonical.full);
    }
  });
});
