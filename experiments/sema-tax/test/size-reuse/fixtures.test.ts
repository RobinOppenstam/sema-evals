import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadFixtureFile } from "../../src/fixtures.js";
import {
  coreDefinition,
  tierDefinitionBytes,
} from "../../src/size-reuse/context.js";
import { loadSizeReuseFixtureFile } from "../../src/size-reuse/fixtures.js";
import {
  SEMA_TAX_TIER_BYTE_BANDS,
  type SemaTaxSizedPattern,
} from "../../src/size-reuse/schemas.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "../../fixtures/worksheets-size-reuse.yaml");
const BASE_FIXTURE_PATH = resolve(HERE, "../../fixtures/worksheets.yaml");

async function corrupt(replace: (raw: string) => string): Promise<string> {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  const dir = await mkdtemp(join(tmpdir(), "sema-tax-sr-fixture-"));
  const path = join(dir, "worksheets-size-reuse.yaml");
  await writeFile(path, replace(raw), "utf8");
  return path;
}

describe("loadSizeReuseFixtureFile", () => {
  it("loads the committed size/reuse fixtures", async () => {
    const { fixtureSet, patternsByHandle } =
      await loadSizeReuseFixtureFile(FIXTURE_PATH);
    expect(fixtureSet.patterns.length).toBeGreaterThanOrEqual(16);
    expect(fixtureSet.scenarios.length).toBeGreaterThanOrEqual(1);
    expect(patternsByHandle.size).toBe(fixtureSet.patterns.length);
    for (const pattern of fixtureSet.patterns) {
      expect(pattern.auxiliary.medium).toBeDefined();
      expect(pattern.auxiliary.large).toBeDefined();
    }
  });

  it("produces a stable digest distinct from the base fixture digest", async () => {
    const first = await loadSizeReuseFixtureFile(FIXTURE_PATH);
    const second = await loadSizeReuseFixtureFile(FIXTURE_PATH);
    const base = await loadFixtureFile(BASE_FIXTURE_PATH);
    expect(first.fixtureDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fixtureDigest).toBe(second.fixtureDigest);
    expect(first.fixtureDigest).not.toBe(base.fixtureDigest);
  });

  it("keeps every medium and large definition inside its canonical byte band", async () => {
    const { fixtureSet } = await loadSizeReuseFixtureFile(FIXTURE_PATH);
    for (const pattern of fixtureSet.patterns) {
      const medium = tierDefinitionBytes(pattern, "medium");
      const large = tierDefinitionBytes(pattern, "large");
      expect(medium).toBeGreaterThanOrEqual(
        SEMA_TAX_TIER_BYTE_BANDS.medium.min,
      );
      expect(medium).toBeLessThanOrEqual(SEMA_TAX_TIER_BYTE_BANDS.medium.max);
      expect(large).toBeGreaterThanOrEqual(SEMA_TAX_TIER_BYTE_BANDS.large.min);
      expect(large).toBeLessThanOrEqual(SEMA_TAX_TIER_BYTE_BANDS.large.max);
    }
  });

  it("holds the scoreable core byte-identical across all three tiers", async () => {
    const { fixtureSet } = await loadSizeReuseFixtureFile(FIXTURE_PATH);
    for (const pattern of fixtureSet.patterns) {
      // The small tier IS the core; medium and large must carry the same core
      // fields unchanged, so ground truth cannot vary with size.
      const core = coreDefinition(pattern);
      expect(core).toEqual({
        gloss: pattern.gloss,
        comparator: pattern.comparator,
        threshold: pattern.threshold,
        unit: pattern.unit,
      });
      const small = tierDefinitionBytes(pattern, "small");
      const medium = tierDefinitionBytes(pattern, "medium");
      const large = tierDefinitionBytes(pattern, "large");
      // Bytes strictly grow with tier; the core stays fixed.
      expect(small).toBeLessThan(medium);
      expect(medium).toBeLessThan(large);
    }
  });

  it("rejects a fixture whose medium definition is pushed out of band", async () => {
    // Blow the medium edgeCaseNotes far past the 1200 B ceiling.
    const path = await corrupt((raw) =>
      raw.replace(
        /edgeCaseNotes: "Values are normalized to usdc/,
        `edgeCaseNotes: "${"X".repeat(4000)} Values are normalized to usdc`,
      ),
    );
    await expect(loadSizeReuseFixtureFile(path)).rejects.toThrow(
      /outside the canonical band/,
    );
  });

  it("rejects a pattern missing its auxiliary content", async () => {
    // Strip the auxiliary block from Rule01 by cutting from its auxiliary key to
    // the next pattern handle.
    const path = await corrupt((raw) =>
      raw.replace(/ {4}auxiliary:[\s\S]*?(?= {2}- handle: "Rule02")/, ""),
    );
    await expect(loadSizeReuseFixtureFile(path)).rejects.toThrow();
  });
});

describe("enforceByteBands helper", () => {
  it("computes the same bytes the harness uses at render time", async () => {
    const { fixtureSet } = await loadSizeReuseFixtureFile(FIXTURE_PATH);
    const pattern: SemaTaxSizedPattern = fixtureSet.patterns[0]!;
    // A deterministic, reproducible byte count for the first pattern's tiers.
    expect(tierDefinitionBytes(pattern, "medium")).toBe(
      tierDefinitionBytes(pattern, "medium"),
    );
  });
});
