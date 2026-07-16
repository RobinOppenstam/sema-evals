import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadCases } from "../src/fixtures.js";
import { securityCaseSchema } from "../src/schemas.js";

const CASES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cases",
);

describe("security fixture catalog", () => {
  it("loads and schema-validates all 9 cases with 5 train / 4 heldout", async () => {
    const loaded = await loadCases(CASES_DIR);
    expect(loaded.cases).toHaveLength(9);
    expect(loaded.trainCaseCount).toBe(5);
    expect(loaded.heldoutCaseCount).toBe(4);
    expect(loaded.fixtureDigest).toMatch(/^[0-9a-f]{64}$/);

    for (const entry of loaded.cases) {
      expect(securityCaseSchema.safeParse(entry.meta).success).toBe(true);
      expect(entry.vulnerableSource.length).toBeGreaterThan(0);
      expect(entry.patchedSource.length).toBeGreaterThan(0);
      expect(entry.vulnerableSource.split("\n").length).toBeLessThan(80);
      expect(entry.patchedSource.split("\n").length).toBeLessThan(80);
    }
  });

  it("keeps every vulnerability class in both splits", async () => {
    const loaded = await loadCases(CASES_DIR);
    for (const split of ["train", "heldout"] as const) {
      const classes = new Set(
        loaded.cases
          .filter((entry) => entry.meta.split === split)
          .map((entry) => entry.meta.class),
      );
      expect(classes.has("reentrancy")).toBe(true);
      expect(classes.has("access-control")).toBe(true);
      expect(classes.has("unchecked-external-call")).toBe(true);
    }
  });
});
