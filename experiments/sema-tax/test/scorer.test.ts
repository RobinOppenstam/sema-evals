import { describe, expect, it } from "vitest";

import type { SemaTaxItem, SemaTaxPattern } from "../src/schemas.js";
import {
  SEMA_TAX_SCORER_VERSION,
  evaluateItem,
  parseWorksheetAnswers,
  scoreWorksheet,
} from "../src/scorer.js";

function pattern(
  handle: string,
  comparator: SemaTaxPattern["comparator"],
  threshold: number,
): SemaTaxPattern {
  return { handle, gloss: `${handle} gloss`, comparator, threshold, unit: "u" };
}

describe("evaluateItem", () => {
  it("applies each comparator as executable ground truth", () => {
    expect(evaluateItem(pattern("A", ">=", 100), 100)).toBe("yes");
    expect(evaluateItem(pattern("A", ">=", 100), 99)).toBe("no");
    expect(evaluateItem(pattern("A", ">", 100), 100)).toBe("no");
    expect(evaluateItem(pattern("A", "<=", 100), 100)).toBe("yes");
    expect(evaluateItem(pattern("A", "<", 100), 100)).toBe("no");
    expect(evaluateItem(pattern("A", "==", 100), 100)).toBe("yes");
    expect(evaluateItem(pattern("A", "==", 100), 101)).toBe("no");
  });
});

describe("parseWorksheetAnswers", () => {
  it("parses strict lines and the last answer for an item wins", () => {
    const answers = parseWorksheetAnswers(
      "reasoning\nITEM item-01: yes\nITEM item-02: no\nITEM item-01: no",
    );
    expect(answers.get("item-01")).toBe("no");
    expect(answers.get("item-02")).toBe("no");
  });

  it("tolerates markdown emphasis and case, like the relay decision parser", () => {
    const answers = parseWorksheetAnswers(
      "**ITEM item-01: YES**\n`ITEM item-02: No`\n### ITEM item-03: yes.",
    );
    expect(answers.get("item-01")).toBe("yes");
    expect(answers.get("item-02")).toBe("no");
    expect(answers.get("item-03")).toBe("yes");
  });

  it("ignores prose and non-yes/no answers", () => {
    const answers = parseWorksheetAnswers(
      "The item item-01: yes was discussed.\nITEM item-02: maybe",
    );
    expect(answers.has("item-01")).toBe(false);
    expect(answers.has("item-02")).toBe(false);
  });
});

describe("scoreWorksheet", () => {
  const patternsByHandle = new Map<string, SemaTaxPattern>([
    ["A", pattern("A", ">=", 100)],
    ["B", pattern("B", "<", 50)],
  ]);
  const items: SemaTaxItem[] = [
    { id: "item-01", patternHandle: "A", value: 150 }, // yes
    { id: "item-02", patternHandle: "B", value: 60 }, // no
  ];

  it("scores exact matches against ground truth", () => {
    const score = scoreWorksheet(
      items,
      patternsByHandle,
      "ITEM item-01: yes\nITEM item-02: no",
    );
    expect(score.itemsCorrect).toBe(2);
    expect(score.itemsAnswered).toBe(2);
    expect(score.score).toBe(1);
    expect(score.taskSuccess).toBe(true);
    expect(score.scorerVersion).toBe(SEMA_TAX_SCORER_VERSION);
  });

  it("counts missing and wrong answers as incorrect, never dropped", () => {
    const score = scoreWorksheet(
      items,
      patternsByHandle,
      "ITEM item-01: no", // wrong; item-02 missing
    );
    expect(score.itemsCorrect).toBe(0);
    expect(score.score).toBe(0);
    expect(score.taskSuccess).toBe(false);
    expect(score.perItem[1]?.answered).toBe("missing");
  });

  it("separates answered from correct: a wrong-but-parseable item is answered", () => {
    // item-01 answered wrong, item-02 answered right -> 2 answered, 1 correct.
    const score = scoreWorksheet(
      items,
      patternsByHandle,
      "ITEM item-01: no\nITEM item-02: no",
    );
    expect(score.itemsAnswered).toBe(2);
    expect(score.itemsCorrect).toBe(1);
  });

  it("counts markdown-wrapped answer lines as answered", () => {
    const score = scoreWorksheet(
      items,
      patternsByHandle,
      "**ITEM item-01: yes**\n`ITEM item-02: no`",
    );
    expect(score.itemsAnswered).toBe(2);
    expect(score.itemsCorrect).toBe(2);
  });

  it("does not count missing items toward itemsAnswered", () => {
    const score = scoreWorksheet(
      items,
      patternsByHandle,
      "ITEM item-01: yes", // item-02 has no line at all
    );
    expect(score.itemsAnswered).toBe(1);
    expect(score.perItem[1]?.answered).toBe("missing");
  });

  it("does not double-count duplicate answer lines for one item", () => {
    // Two lines for item-01, none for item-02: still exactly one answered item.
    const score = scoreWorksheet(
      items,
      patternsByHandle,
      "ITEM item-01: no\nITEM item-01: yes",
    );
    expect(score.itemsAnswered).toBe(1);
  });

  it("grades partial worksheets", () => {
    const score = scoreWorksheet(
      items,
      patternsByHandle,
      "ITEM item-01: yes\nITEM item-02: yes", // item-02 wrong
    );
    expect(score.itemsCorrect).toBe(1);
    expect(score.score).toBe(0.5);
  });

  it("throws when an item references an unknown pattern", () => {
    expect(() =>
      scoreWorksheet(
        [{ id: "x", patternHandle: "Z", value: 1 }],
        patternsByHandle,
        "",
      ),
    ).toThrow(/unknown pattern/);
  });
});
