import { describe, expect, it } from "vitest";

import {
  PreregistrationError,
  parsePreregistration,
  verifyFreeze,
  type PreregistrationPins,
} from "../src/preregistration.js";

// A minimal document shaped exactly like preregistration 001 §4 and §7.
const FIXTURE_DIGEST =
  "a8dcdc8d29395b62cfac17b69895b0c71f76f977e3d3c3ccca4a2f9166d97e2c";
const PROMPT_DIGEST =
  "5f8976a6e93d1816dbd1341d5b906df443692e6c81b3ffe2f97e273f394aa99d";
const SCORER_VERSION = "decision-parser-v2-markdown-tolerant";

const DOC = `## 4. Randomization

- Order: shuffled by the recorded order seed **20260716** (fresh — not used by
  any prior run; pilots used 20260714).

## 7. Frozen artifacts (registration pins)

- Fixture digest: \`${FIXTURE_DIGEST}\`
- Prompt digest: \`${PROMPT_DIGEST}\`
- Scorer version: \`${SCORER_VERSION}\`
`;

const CLEAN_COMMIT = "abc123def456";

function pins(): PreregistrationPins {
  return {
    fixtureDigest: FIXTURE_DIGEST,
    promptDigest: PROMPT_DIGEST,
    scorerVersion: SCORER_VERSION,
    orderSeed: 20_260_716,
  };
}

describe("parsePreregistration", () => {
  it("parses the §7 pins and §4 order seed", () => {
    const parsed = parsePreregistration(DOC);
    expect(parsed.fixtureDigest).toBe(FIXTURE_DIGEST);
    expect(parsed.promptDigest).toBe(PROMPT_DIGEST);
    expect(parsed.scorerVersion).toBe(SCORER_VERSION);
    expect(parsed.orderSeed).toBe(20_260_716);
  });

  it("throws when the fixture digest is missing", () => {
    const doc = DOC.replace(/- Fixture digest:.*\n/, "");
    expect(() => parsePreregistration(doc)).toThrow(/fixture digest/i);
  });

  it("throws when the order seed is missing", () => {
    const doc = DOC.replace(/order seed \*\*20260716\*\*/, "order seed");
    expect(() => parsePreregistration(doc)).toThrow(/order seed/i);
  });

  it("throws when the scorer version is missing", () => {
    const doc = DOC.replace(/- Scorer version:.*\n/, "");
    expect(() => parsePreregistration(doc)).toThrow(/scorer version/i);
  });
});

describe("verifyFreeze", () => {
  const state = {
    fixtureDigest: FIXTURE_DIGEST,
    promptDigest: PROMPT_DIGEST,
    scorerVersion: SCORER_VERSION,
    orderSeed: 20_260_716,
    implementationCommit: CLEAN_COMMIT,
  };

  it("passes when every pin matches and the tree is clean", () => {
    expect(() => verifyFreeze(pins(), state)).not.toThrow();
  });

  it("refuses on a wrong fixture digest, naming the mismatch", () => {
    const wrong = { ...state, fixtureDigest: "0".repeat(64) };
    expect(() => verifyFreeze(pins(), wrong)).toThrow(PreregistrationError);
    expect(() => verifyFreeze(pins(), wrong)).toThrow(/fixture digest/);
    expect(() => verifyFreeze(pins(), wrong)).toThrow(FIXTURE_DIGEST);
  });

  it("refuses on a wrong prompt digest", () => {
    const wrong = { ...state, promptDigest: "1".repeat(64) };
    expect(() => verifyFreeze(pins(), wrong)).toThrow(/prompt digest/);
  });

  it("refuses on a scorer-version drift", () => {
    const wrong = { ...state, scorerVersion: "decision-parser-v1" };
    expect(() => verifyFreeze(pins(), wrong)).toThrow(/scorer version/);
  });

  it("refuses on an order-seed mismatch", () => {
    const wrong = { ...state, orderSeed: 20_260_714 };
    expect(() => verifyFreeze(pins(), wrong)).toThrow(/order seed/);
  });

  it("refuses on a dirty tree", () => {
    const wrong = { ...state, implementationCommit: `${CLEAN_COMMIT}+dirty` };
    expect(() => verifyFreeze(pins(), wrong)).toThrow(/dirty/);
  });

  it("names every mismatch at once", () => {
    const wrong = {
      fixtureDigest: "0".repeat(64),
      promptDigest: "1".repeat(64),
      scorerVersion: "other",
      orderSeed: 1,
      implementationCommit: `${CLEAN_COMMIT}+dirty`,
    };
    let message = "";
    try {
      verifyFreeze(pins(), wrong);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/fixture digest/);
    expect(message).toMatch(/prompt digest/);
    expect(message).toMatch(/scorer version/);
    expect(message).toMatch(/order seed/);
    expect(message).toMatch(/dirty/);
  });
});
