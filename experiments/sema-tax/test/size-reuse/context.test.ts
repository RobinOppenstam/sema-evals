import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import { describe, expect, it } from "vitest";

import { parseCondition } from "../../src/conditions.js";
import { assembleContext } from "../../src/context.js";
import { loadFixtureFile } from "../../src/fixtures.js";
import {
  accountMessage,
  assembleSizeReuseTemplate,
  messageIncludesDefinitions,
  tierDefinition,
} from "../../src/size-reuse/context.js";
import { loadSizeReuseFixtureFile } from "../../src/size-reuse/fixtures.js";
import type {
  SemaTaxSizeReuseDelivery,
  SemaTaxSizeTier,
} from "../../src/size-reuse/schemas.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "../../fixtures/worksheets-size-reuse.yaml");
const BASE_FIXTURE_PATH = resolve(HERE, "../../fixtures/worksheets.yaml");
const P8 = 8;

async function template(
  scenarioId: string,
  tier: SemaTaxSizeTier,
  delivery: SemaTaxSizeReuseDelivery,
) {
  const { fixtureSet, patternsByHandle } =
    await loadSizeReuseFixtureFile(FIXTURE_PATH);
  const scenario = fixtureSet.scenarios.find((s) => s.id === scenarioId)!;
  return assembleSizeReuseTemplate(
    scenario,
    P8,
    tier,
    delivery,
    patternsByHandle,
    new FixtureReferenceProvider(),
  );
}

describe("tierDefinition", () => {
  it("adds auxiliary content for medium and large while keeping the core", async () => {
    const { patternsByHandle } = await loadSizeReuseFixtureFile(FIXTURE_PATH);
    const pattern = patternsByHandle.get("Rule01")!;
    const small = tierDefinition(pattern, "small");
    const medium = tierDefinition(pattern, "medium");
    const large = tierDefinition(pattern, "large");
    expect(Object.keys(small).sort()).toEqual([
      "comparator",
      "gloss",
      "threshold",
      "unit",
    ]);
    // Core fields identical across tiers.
    for (const rendered of [medium, large]) {
      expect(rendered.comparator).toBe(small.comparator);
      expect(rendered.threshold).toBe(small.threshold);
      expect(rendered.unit).toBe(small.unit);
      expect(rendered.gloss).toBe(small.gloss);
      expect(rendered).toHaveProperty("rationale");
      expect(rendered).toHaveProperty("boundaryExamples");
      expect(rendered).toHaveProperty("edgeCaseNotes");
    }
  });
});

describe("assembleSizeReuseTemplate delivery channels", () => {
  it("puts full definitions on the prose wire and never hydrates", async () => {
    const prose = await template("settlement-desk", "medium", "prose");
    expect(prose.referenceBlock).toBe("");
    expect(prose.definitionsHydrationBytes).toBe(0);
    expect(prose.hydratesOnFirstMessage).toBe(false);
    // The definitions block is present and non-trivial.
    expect(prose.definitionsBlock).toContain("Resolved definitions");
  });

  it("puts only compact references on the resolver wire and hydrates once", async () => {
    const opaque = await template("settlement-desk", "medium", "opaque");
    const content = await template("settlement-desk", "medium", "content");
    for (const resolver of [opaque, content]) {
      expect(resolver.referenceBlock).toContain("Semantic references");
      expect(resolver.definitionsHydrationBytes).toBeGreaterThan(0);
      expect(resolver.hydratesOnFirstMessage).toBe(true);
    }
    // The resolver wire is much smaller than the prose wire at the same tier
    // (references vs inlined definitions).
    const prose = await template("settlement-desk", "medium", "prose");
    expect(opaque.wireBytesPerMessage).toBeLessThan(prose.wireBytesPerMessage);
    expect(content.wireBytesPerMessage).toBeLessThan(prose.wireBytesPerMessage);
    // Information parity: the hydrated definition bytes match the prose payload's
    // definitions (identical resolved-definition content).
    expect(opaque.definitionsHydrationBytes).toBe(
      content.definitionsHydrationBytes,
    );
  });

  it("grows the prose wire monotonically with the size tier", async () => {
    const small = await template("settlement-desk", "small", "prose");
    const medium = await template("settlement-desk", "medium", "prose");
    const large = await template("settlement-desk", "large", "prose");
    expect(small.wireBytesPerMessage).toBeLessThan(medium.wireBytesPerMessage);
    expect(medium.wireBytesPerMessage).toBeLessThan(large.wireBytesPerMessage);
  });
});

describe("accountMessage per-message wire and hydration", () => {
  it("charges prose the same wire every message and no hydration", async () => {
    const prose = await template("settlement-desk", "large", "prose");
    const first = accountMessage(prose, 0, "resp");
    const later = accountMessage(prose, 4, "resp");
    expect(first.wireBytes).toBe(later.wireBytes);
    expect(first.hydrationBytes).toBe(0);
    expect(later.hydrationBytes).toBe(0);
    // Prose re-sends the definitions every message: definitions present always.
    expect(messageIncludesDefinitions(prose, 0)).toBe(true);
    expect(messageIncludesDefinitions(prose, 4)).toBe(true);
    expect(first.inputTokens).toBe(later.inputTokens);
  });

  it("charges the resolver hydration on message 0 only, wire every message", async () => {
    const content = await template("settlement-desk", "large", "content");
    const first = accountMessage(content, 0, "resp");
    const later = accountMessage(content, 5, "resp");
    // Wire (references) is paid every message and is constant.
    expect(first.wireBytes).toBe(later.wireBytes);
    // Hydration paid once (message 0), zero thereafter.
    expect(first.hydrationBytes).toBe(content.definitionsHydrationBytes);
    expect(later.hydrationBytes).toBe(0);
    // Definitions ingested once: message 0 carries them, later messages do not,
    // so later input tokens are strictly cheaper.
    expect(messageIncludesDefinitions(content, 0)).toBe(true);
    expect(messageIncludesDefinitions(content, 5)).toBe(false);
    expect(later.inputTokens).toBeLessThan(first.inputTokens);
  });
});

describe("small x R1 anchor parity with the base p8 cold arm", () => {
  it("reproduces the base p8 prose/opaque/content cold wire bytes", async () => {
    const { fixtureSet: base, patternsByHandle: basePatterns } =
      await loadFixtureFile(BASE_FIXTURE_PATH);
    const scenario = base.scenarios.find((s) => s.id === "settlement-desk")!;
    const provider = new FixtureReferenceProvider();

    for (const delivery of ["prose", "opaque", "content"] as const) {
      const baseContext = await assembleContext(
        scenario,
        parseCondition(`p8-${delivery}-cold`),
        basePatterns,
        provider,
      );
      const armTemplate = await template("settlement-desk", "small", delivery);
      // small x R1 is byte-parity with the base p8 cold cell for this delivery.
      expect(armTemplate.wireBytesPerMessage).toBe(baseContext.wireBytes);
      const firstMessage = accountMessage(armTemplate, 0, "resp");
      expect(firstMessage.hydrationBytes).toBe(baseContext.hydrationBytes);
    }
  });
});
