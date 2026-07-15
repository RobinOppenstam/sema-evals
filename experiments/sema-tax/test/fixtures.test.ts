import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadFixtureFile } from "../src/fixtures.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/worksheets.yaml",
);

async function writeTempFixture(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sema-tax-fixture-"));
  const path = join(dir, "worksheets.yaml");
  await writeFile(path, body, "utf8");
  return path;
}

const MINIMAL_PATTERNS = Array.from({ length: 16 }, (_, index) => {
  const handle = `Rule${String(index + 1).padStart(2, "0")}`;
  return `  - handle: "${handle}"\n    gloss: "g"\n    comparator: ">="\n    threshold: ${index}\n    unit: "u"`;
}).join("\n");

const POOL = Array.from(
  { length: 16 },
  (_, index) => `"Rule${String(index + 1).padStart(2, "0")}"`,
).join(", ");

describe("loadFixtureFile", () => {
  it("loads the committed worksheet fixtures", async () => {
    const { fixtureSet, patternsByHandle } =
      await loadFixtureFile(FIXTURE_PATH);
    expect(fixtureSet.patterns.length).toBeGreaterThanOrEqual(16);
    expect(fixtureSet.scenarios.length).toBeGreaterThanOrEqual(1);
    expect(patternsByHandle.size).toBe(fixtureSet.patterns.length);
    for (const scenario of fixtureSet.scenarios) {
      expect(scenario.patternPool.length).toBeGreaterThanOrEqual(16);
    }
  });

  it("produces a stable 64-char digest", async () => {
    const first = await loadFixtureFile(FIXTURE_PATH);
    const second = await loadFixtureFile(FIXTURE_PATH);
    expect(first.fixtureDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fixtureDigest).toBe(second.fixtureDigest);
  });

  it("rejects a pool shorter than the largest studied count", async () => {
    const shortPool = Array.from(
      { length: 15 },
      (_, index) => `"Rule${String(index + 1).padStart(2, "0")}"`,
    ).join(", ");
    const path = await writeTempFixture(
      `schemaVersion: "0.1.0"\npatterns:\n${MINIMAL_PATTERNS}\nscenarios:\n  - id: "s"\n    title: "t"\n    prompt: "p"\n    patternPool: [${shortPool}]\n    items:\n      - id: "item-01"\n        patternHandle: "Rule01"\n        value: 1\n`,
    );
    await expect(loadFixtureFile(path)).rejects.toThrow();
  });

  it("rejects an item whose pattern is outside the scenario pool", async () => {
    const path = await writeTempFixture(
      `schemaVersion: "0.1.0"\npatterns:\n${MINIMAL_PATTERNS}\nscenarios:\n  - id: "s"\n    title: "t"\n    prompt: "p"\n    patternPool: [${POOL}]\n    items:\n      - id: "item-01"\n        patternHandle: "Rule20"\n        value: 1\n`,
    );
    await expect(loadFixtureFile(path)).rejects.toThrow(
      /not in the scenario pool|unknown pattern/,
    );
  });

  it("rejects a duplicate pattern handle", async () => {
    const path = await writeTempFixture(
      `schemaVersion: "0.1.0"\npatterns:\n${MINIMAL_PATTERNS}\n  - handle: "Rule01"\n    gloss: "g"\n    comparator: ">="\n    threshold: 9\n    unit: "u"\nscenarios:\n  - id: "s"\n    title: "t"\n    prompt: "p"\n    patternPool: [${POOL}]\n    items:\n      - id: "item-01"\n        patternHandle: "Rule01"\n        value: 1\n`,
    );
    await expect(loadFixtureFile(path)).rejects.toThrow(/Duplicate pattern/);
  });
});
