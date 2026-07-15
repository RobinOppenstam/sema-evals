import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import { utf8Bytes } from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import { parseCondition } from "../src/conditions.js";
import { assembleContext, patternDefinition } from "../src/context.js";
import { loadFixtureFile } from "../src/fixtures.js";
import type { SemaTaxPattern, SemaTaxScenario } from "../src/schemas.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/worksheets.yaml",
);

const provider = new FixtureReferenceProvider();

async function loadOne(): Promise<{
  scenario: SemaTaxScenario;
  patternsByHandle: Map<string, SemaTaxPattern>;
}> {
  const { fixtureSet, patternsByHandle } = await loadFixtureFile(FIXTURE_PATH);
  const scenario = fixtureSet.scenarios[0];
  if (!scenario) {
    throw new Error("Expected at least one scenario.");
  }
  return { scenario, patternsByHandle };
}

describe("information parity", () => {
  it("gives every delivery arm and cache state a byte-identical definitions block", async () => {
    const { scenario, patternsByHandle } = await loadOne();
    const arms = [
      "p8-prose-cold",
      "p8-prose-warm",
      "p8-opaque-cold",
      "p8-opaque-warm",
      "p8-content-cold",
      "p8-content-warm",
    ];
    const blocks = await Promise.all(
      arms.map(async (id) => {
        const context = await assembleContext(
          scenario,
          parseCondition(id),
          patternsByHandle,
          provider,
        );
        return context.definitionsBlock;
      }),
    );
    const [first] = blocks;
    expect(first).toBeTruthy();
    for (const block of blocks) {
      expect(block).toBe(first);
    }
  });

  it("controls compact lookup: opaque and content resolve the same definitions but differ only in the reference", async () => {
    const { scenario, patternsByHandle } = await loadOne();
    const opaque = await assembleContext(
      scenario,
      parseCondition("p8-opaque-cold"),
      patternsByHandle,
      provider,
    );
    const content = await assembleContext(
      scenario,
      parseCondition("p8-content-cold"),
      patternsByHandle,
      provider,
    );
    expect(opaque.definitionsBlock).toBe(content.definitionsBlock);
    expect(opaque.hydrationBytes).toBe(content.hydrationBytes);
    // The content-addressed reference embeds a digest, so it is strictly larger
    // on the wire than the opaque label — the addressing tax.
    expect(content.wireBytes).toBeGreaterThan(opaque.wireBytes);
    expect(opaque.referenceBlock).toContain("opaque lookup");
    expect(content.referenceBlock).toContain("content-addressed");
  });

  it("records wire and hydration separately per delivery arm", async () => {
    const { scenario, patternsByHandle } = await loadOne();
    const prose = await assembleContext(
      scenario,
      parseCondition("p8-prose-cold"),
      patternsByHandle,
      provider,
    );
    const opaque = await assembleContext(
      scenario,
      parseCondition("p8-opaque-cold"),
      patternsByHandle,
      provider,
    );
    // Prose inlines definitions on the wire and never hydrates.
    expect(prose.hydrationBytes).toBe(0);
    expect(prose.wireBytes).toBeGreaterThan(opaque.wireBytes);
    // The resolver ships compact refs and pays hydration instead.
    expect(opaque.hydrationBytes).toBeGreaterThan(0);
  });

  it("charges hydration only on a cold cache, not warm", async () => {
    const { scenario, patternsByHandle } = await loadOne();
    const cold = await assembleContext(
      scenario,
      parseCondition("p8-content-cold"),
      patternsByHandle,
      provider,
    );
    const warm = await assembleContext(
      scenario,
      parseCondition("p8-content-warm"),
      patternsByHandle,
      provider,
    );
    // Cache changes neither the wire nor the resolved content, only hydration.
    expect(cold.wireBytes).toBe(warm.wireBytes);
    expect(cold.definitionsBlock).toBe(warm.definitionsBlock);
    expect(warm.hydrationBytes).toBe(0);
    expect(cold.hydrationBytes).toBeGreaterThan(0);
  });

  it("computes hydration bytes from the active definition map", async () => {
    const { scenario, patternsByHandle } = await loadOne();
    const cold = await assembleContext(
      scenario,
      parseCondition("p4-opaque-cold"),
      patternsByHandle,
      provider,
    );
    const defsMap: Record<string, unknown> = {};
    for (const entry of cold.activePatterns) {
      const pattern = patternsByHandle.get(entry.handle);
      if (pattern) {
        defsMap[entry.handle] = patternDefinition(pattern);
      }
    }
    expect(cold.activePatterns).toHaveLength(4);
    expect(cold.hydrationBytes).toBe(utf8Bytes(defsMap));
  });
});
