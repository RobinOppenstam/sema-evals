import { describe, expect, it } from "vitest";

import {
  A2A_DECISION_PARSER_VERSION,
  parseWorkerDecision,
} from "../src/decision.js";

describe("parseWorkerDecision", () => {
  it("parses proceed and halt", () => {
    expect(parseWorkerDecision("ok\nDECISION: proceed — done")).toBe("proceed");
    expect(parseWorkerDecision("bad\nDECISION: halt — mismatch\n")).toBe(
      "halt",
    );
  });

  it("accepts uppercase verdicts and optional trailing punctuation", () => {
    expect(parseWorkerDecision("DECISION: PROCEED")).toBe("proceed");
    expect(parseWorkerDecision("DECISION: HALT.")).toBe("halt");
  });

  it("is tolerant of markdown emphasis around the keyword", () => {
    expect(parseWorkerDecision("reasoning\n\n**DECISION: proceed**")).toBe(
      "proceed",
    );
    expect(parseWorkerDecision("reasoning\n\n**DECISION: HALT**")).toBe("halt");
    expect(parseWorkerDecision("`DECISION: halt — drift`")).toBe("halt");
  });

  it("lets the last matching line win", () => {
    expect(
      parseWorkerDecision("DECISION: proceed\nDECISION: halt — changed"),
    ).toBe("halt");
  });

  it("preserves garbage as malformed", () => {
    expect(parseWorkerDecision("no decision line here")).toBe("malformed");
    expect(
      parseWorkerDecision("The decision: proceed with caution was discussed."),
    ).toBe("malformed");
    expect(parseWorkerDecision("DECISION: MAYBE")).toBe("malformed");
  });

  it("exports the frozen parser version", () => {
    expect(A2A_DECISION_PARSER_VERSION).toBe("a2a-decision-parser-v1");
  });
});
