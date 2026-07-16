import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertMutationIntegrity, loadCases } from "../src/fixtures.js";

const CASES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cases",
);

describe("mutation integrity", () => {
  it("confirms vulnerable vs patched differ exactly per mutation markers", async () => {
    const loaded = await loadCases(CASES_DIR);
    for (const entry of loaded.cases) {
      expect(() =>
        assertMutationIntegrity(
          entry.meta,
          entry.vulnerableSource,
          entry.patchedSource,
        ),
      ).not.toThrow();
      expect(entry.vulnerableSource).not.toEqual(entry.patchedSource);
      expect(entry.vulnerableSource).toContain(
        entry.meta.mutation.vulnerableMarker,
      );
      expect(entry.patchedSource).toContain(entry.meta.mutation.patchedMarker);
      expect(entry.meta.mutation.description.length).toBeGreaterThan(10);
    }
  });

  it("rejects identical sources", async () => {
    const loaded = await loadCases(CASES_DIR);
    const sample = loaded.cases[0];
    if (!sample) {
      throw new Error("expected cases");
    }
    expect(() =>
      assertMutationIntegrity(
        sample.meta,
        sample.vulnerableSource,
        sample.vulnerableSource,
      ),
    ).toThrow(/identical/);
  });
});
