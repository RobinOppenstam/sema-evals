import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertMutationIntegrity, loadCases } from "../src/fixtures.js";
import { VULNERABILITY_CLASSES } from "../src/schemas.js";

const CASES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cases",
);

/** Collect //, ///, /* *\/, and /** *\/ comment bodies from Solidity source. */
function extractCommentBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/\/\*[\s\S]*?\*\//g)) {
    bodies.push(match[0]);
  }
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const line of withoutBlocks.split("\n")) {
    const lineComment = line.match(/\/\/(.*)$/);
    if (lineComment?.[1] !== undefined) {
      bodies.push(lineComment[1]);
    }
  }
  return bodies;
}

describe("mutation integrity", () => {
  it("confirms vulnerable vs patched differ exactly per mutation snippets", async () => {
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
        entry.meta.mutation.vulnerableSnippet,
      );
      expect(entry.vulnerableSource).not.toContain(
        entry.meta.mutation.patchedSnippet,
      );
      expect(entry.patchedSource).toContain(entry.meta.mutation.patchedSnippet);
      expect(entry.patchedSource).not.toContain(
        entry.meta.mutation.vulnerableSnippet,
      );
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

  it("keeps fixture .sol sources free of ground-truth annotation leakage", async () => {
    const caseDirs = (await readdir(CASES_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const caseId of caseDirs) {
      for (const fileName of ["vulnerable.sol", "patched.sol"] as const) {
        const source = await readFile(
          join(CASES_DIR, caseId, fileName),
          "utf8",
        );
        expect(
          source.includes("VULN"),
          `${caseId}/${fileName} contains VULN`,
        ).toBe(false);
        for (const body of extractCommentBodies(source)) {
          for (const className of VULNERABILITY_CLASSES) {
            expect(
              body.toLowerCase().includes(className.toLowerCase()),
              `${caseId}/${fileName} comment mentions class "${className}": ${body}`,
            ).toBe(false);
          }
        }
      }
    }
  });
});
