import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SemaPythonReferenceProvider } from "@sema-evals/adapters";
import { describe, expect, it } from "vitest";

import {
  assertSemanticDriftsAddressable,
  loadHistoricalForecastingDataset,
} from "../src/model-readiness.js";

const DATASET_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../datasets/acquired/historical-resolved-v1.yaml",
);
// The licensed historical subset is operator-local and intentionally ignored.
// Run this full-dataset integration only where both prerequisites are present;
// CI still covers the provider itself and the fail-closed collapse unit test.
const integration =
  process.env.SEMA_PYTHON && existsSync(DATASET_PATH)
    ? describe
    : describe.skip;

integration(
  "historical forecasting dataset with official semahash Python",
  () => {
    it("gives every declared drift a different official Sema address", async () => {
      const pythonCommand = process.env.SEMA_PYTHON;
      if (!pythonCommand) {
        throw new Error("SEMA_PYTHON is required for this integration test.");
      }
      const provider = new SemaPythonReferenceProvider({ pythonCommand });
      const metadata = await provider.metadata();
      const { dataset } = await loadHistoricalForecastingDataset(DATASET_PATH);

      expect(metadata).toMatchObject({
        backend: "semahash-python-api",
        canonicalizationVersion: "v2",
        officialSema: true,
      });
      await expect(
        assertSemanticDriftsAddressable(dataset.scenarios, provider),
      ).resolves.toBeUndefined();
    }, 15_000);
  },
);
