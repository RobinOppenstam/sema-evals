import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadCases } from "../src/fixtures.js";
import {
  assertNoCardLeakage,
  checkCardLeakage,
  loadPatternCards,
} from "../src/leakage.js";
import type { PatternCard } from "../src/schemas.js";

const CASES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cases",
);
const CARDS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../vocabulary/sema-sec",
);

describe("leakage guard", () => {
  it("passes for the shipped sema-sec cards against heldout identifiers", async () => {
    const loaded = await loadCases(CASES_DIR);
    const cardSet = await loadPatternCards(CARDS_DIR);
    expect(cardSet.cards).toHaveLength(3);
    const report = checkCardLeakage(
      cardSet.cards,
      loaded.cases.map((entry) => entry.meta),
    );
    expect(report.clean).toBe(true);
    expect(report.hits).toEqual([]);
    expect(report.heldoutIdentifiers.length).toBeGreaterThan(0);
    expect(() =>
      assertNoCardLeakage(
        cardSet.cards,
        loaded.cases.map((entry) => entry.meta),
      ),
    ).not.toThrow();
  });

  it("FAILS when a card deliberately leaks a heldout identifier", async () => {
    const loaded = await loadCases(CASES_DIR);
    const cardSet = await loadPatternCards(CARDS_DIR);
    const leaking: PatternCard = {
      ...cardSet.cards[0]!,
      description: `${cardSet.cards[0]!.description} See also BountyBoard.claimBounty.`,
    };
    const report = checkCardLeakage(
      [leaking, ...cardSet.cards.slice(1)],
      loaded.cases.map((entry) => entry.meta),
    );
    expect(report.clean).toBe(false);
    expect(report.hits.some((hit) => hit.identifier === "BountyBoard")).toBe(
      true,
    );
    expect(() =>
      assertNoCardLeakage(
        [leaking, ...cardSet.cards.slice(1)],
        loaded.cases.map((entry) => entry.meta),
      ),
    ).toThrow(/Pattern Card leakage/);
  });
});
