import { describe, expect, it } from "vitest";

import {
  parseAuditorOutput,
  scoreFindings,
  SECURITY_SCORER_VERSION,
} from "../src/scorer.js";

const EXPECTED = [{ class: "reentrancy" as const, function: "claim" }];

describe("security-scorer-v1", () => {
  it("exposes the frozen version string", () => {
    expect(SECURITY_SCORER_VERSION).toBe("security-scorer-v1");
  });

  it("scores a true positive with zero false positives", () => {
    const parsed = parseAuditorOutput(
      "FINDING: reentrancy @ claim\nDECISION: SUBMIT\n",
    );
    expect(parsed.parseable).toBe(true);
    const score = scoreFindings(EXPECTED, parsed, 1);
    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(0);
    expect(score.falseNegatives).toBe(0);
    expect(score.recall).toBe(1);
    expect(score.withinFpBudget).toBe(true);
  });

  it("counts an unmatched finding as a false positive and respects the budget", () => {
    const parsed = parseAuditorOutput(
      [
        "FINDING: reentrancy @ claim",
        "FINDING: access-control @ setTreasury",
        "DECISION: SUBMIT",
      ].join("\n"),
    );
    const score = scoreFindings(EXPECTED, parsed, 1);
    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(1);
    expect(score.withinFpBudget).toBe(true);

    const overBudget = scoreFindings(EXPECTED, parsed, 0);
    expect(overBudget.withinFpBudget).toBe(false);
  });

  it("treats a miss as a false negative with recall 0", () => {
    const parsed = parseAuditorOutput("DECISION: NONE\n");
    const score = scoreFindings(EXPECTED, parsed, 1);
    expect(score.truePositives).toBe(0);
    expect(score.falseNegatives).toBe(1);
    expect(score.recall).toBe(0);
    expect(score.withinFpBudget).toBe(true);
  });

  it("preserves unparseable output as a parse failure (never dropped)", () => {
    const parsed = parseAuditorOutput("I think this is reentrancy maybe?\n");
    expect(parsed.parseable).toBe(false);
    expect(parsed.decisionKind).toBe("missing");
    const score = scoreFindings(EXPECTED, parsed, 1);
    expect(score.parseFailure).toBe(true);
    expect(score.truePositives).toBe(0);
    expect(score.falseNegatives).toBe(1);
    expect(score.recall).toBe(0);
    expect(score.withinFpBudget).toBe(false);
  });

  it("rejects a malformed DECISION line", () => {
    const parsed = parseAuditorOutput(
      "FINDING: reentrancy @ claim\nDECISION: MAYBE\n",
    );
    expect(parsed.parseable).toBe(false);
    expect(parsed.decisionKind).toBe("malformed");
  });

  it("parses DECISION: ADDRESS digests", () => {
    const digest = "a".repeat(64);
    const parsed = parseAuditorOutput(
      `FINDING: reentrancy @ claim\nDECISION: ADDRESS ${digest}\n`,
    );
    expect(parsed.parseable).toBe(true);
    expect(parsed.decisionKind).toBe("address");
    expect(parsed.addressedDigests).toEqual([digest]);
  });

  it("tolerates markdown emphasis around FINDING/DECISION lines", () => {
    const parsed = parseAuditorOutput(
      "**FINDING: reentrancy @ claim**\n**DECISION: SUBMIT**\n",
    );
    expect(parsed.parseable).toBe(true);
    expect(parsed.findings).toEqual([
      { class: "reentrancy", function: "claim" },
    ]);
  });
});
