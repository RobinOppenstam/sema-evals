import { describe, expect, it } from "vitest";

import { trialRecordSchema } from "../../packages/core/src/schemas.js";
import {
  buildPublicTrialsJsonl,
  redactTrialRecord,
  TRANSCRIPT_TEXT_CAP,
} from "../lib/public-derivative.js";
import { makeTrial } from "./fixtures.js";

function withTranscript() {
  const longText = "x".repeat(TRANSCRIPT_TEXT_CAP + 500);
  return makeTrial({
    scenarioId: "s1",
    condition: "equal-prose",
    seed: 0,
    metrics: { taskSuccess: true },
    transcript: {
      entries: [
        {
          index: 0,
          attempt: 0,
          role: "assistant",
          content: [
            { type: "text", text: longText, toolName: null, toolInput: null },
            { type: "text", text: "short", toolName: null, toolInput: null },
            {
              type: "tool_use",
              text: null,
              toolName: "verify",
              toolInput: { a: 1 },
            },
          ],
          raw: { provider: "internal", secret: "keep-out" },
        },
      ],
    },
  });
}

describe("redactTrialRecord", () => {
  it("replaces every transcript raw payload with null", () => {
    const derived = redactTrialRecord(withTranscript());
    for (const entry of derived.transcript?.entries ?? []) {
      expect(entry.raw).toBeNull();
    }
  });

  it("caps long content-block text and marks the truncation", () => {
    const derived = redactTrialRecord(withTranscript());
    const blocks = derived.transcript?.entries[0]?.content ?? [];
    const long = blocks[0]?.text ?? "";
    expect(long.startsWith("x".repeat(TRANSCRIPT_TEXT_CAP))).toBe(true);
    expect(long).toContain("[truncated 500 chars]");
    // Retained prefix is exactly the cap; the rest is the marker only.
    expect(long.slice(0, TRANSCRIPT_TEXT_CAP)).toBe(
      "x".repeat(TRANSCRIPT_TEXT_CAP),
    );
    expect(long).not.toContain("x".repeat(TRANSCRIPT_TEXT_CAP + 1));
  });

  it("leaves short and null content untouched", () => {
    const derived = redactTrialRecord(withTranscript());
    const blocks = derived.transcript?.entries[0]?.content ?? [];
    expect(blocks[1]?.text).toBe("short");
    expect(blocks[2]?.text).toBeNull();
    expect(blocks[2]?.toolName).toBe("verify");
    expect(blocks[2]?.toolInput).toEqual({ a: 1 });
  });

  it("preserves metrics and provenance unchanged", () => {
    const original = withTranscript();
    const derived = redactTrialRecord(original);
    expect(derived.metrics).toEqual(original.metrics);
    expect(derived.provenance).toEqual(original.provenance);
  });

  it("produces a schema-valid derivative", () => {
    const derived = redactTrialRecord(withTranscript());
    expect(() => trialRecordSchema.parse(derived)).not.toThrow();
  });

  it("passes through records without a transcript", () => {
    const derived = redactTrialRecord(
      makeTrial({
        scenarioId: "s2",
        condition: "baseline",
        seed: 0,
        metrics: {},
      }),
    );
    expect(derived.transcript).toBeNull();
  });
});

describe("buildPublicTrialsJsonl", () => {
  it("redacts every line, skips blanks, and stays parseable", () => {
    const a = withTranscript();
    const b = makeTrial({
      scenarioId: "s2",
      condition: "baseline",
      seed: 1,
      metrics: {},
    });
    const source = `${JSON.stringify(a)}\n\n${JSON.stringify(b)}\n`;
    const output = buildPublicTrialsJsonl(source);
    const lines = output.trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) =>
      trialRecordSchema.parse(JSON.parse(line)),
    );
    expect(parsed[0]?.transcript?.entries[0]?.raw).toBeNull();
    expect(parsed[1]?.transcript).toBeNull();
    expect(output.endsWith("\n")).toBe(true);
  });
});
