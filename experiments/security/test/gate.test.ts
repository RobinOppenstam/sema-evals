import { describe, expect, it } from "vitest";

import { applyEnforcementGate } from "../src/gate.js";
import { parseAuditorOutput } from "../src/scorer.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

describe("enforcement gate", () => {
  it("admits findings when all required digests are addressed", () => {
    const parsed = parseAuditorOutput(
      `FINDING: reentrancy @ claim\nDECISION: ADDRESS ${DIGEST_A}, ${DIGEST_B}\n`,
    );
    const result = applyEnforcementGate(parsed, [DIGEST_A]);
    expect(result.refused).toBe(false);
    expect(result.admitted.findings).toHaveLength(1);
  });

  it("refuses findings when the DECISION omits required digests", () => {
    const parsed = parseAuditorOutput(
      `FINDING: reentrancy @ claim\nDECISION: ADDRESS ${DIGEST_B}\n`,
    );
    const result = applyEnforcementGate(parsed, [DIGEST_A]);
    expect(result.refused).toBe(true);
    expect(result.reason).toMatch(/missing-required-digests/);
    expect(result.admitted.findings).toEqual([]);
  });

  it("refuses SUBMIT decisions under enforcement", () => {
    const parsed = parseAuditorOutput(
      "FINDING: reentrancy @ claim\nDECISION: SUBMIT\n",
    );
    const result = applyEnforcementGate(parsed, [DIGEST_A]);
    expect(result.refused).toBe(true);
    expect(result.reason).toBe("missing-address-decision");
    expect(result.admitted.findings).toEqual([]);
  });

  it("refuses unparseable output", () => {
    const parsed = parseAuditorOutput("nope");
    const result = applyEnforcementGate(parsed, [DIGEST_A]);
    expect(result.refused).toBe(true);
    expect(result.reason).toBe("unparseable-auditor-output");
  });
});
