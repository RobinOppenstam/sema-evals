import { describe, expect, it } from "vitest";

import { semaTaxTrialRecordSchema } from "../../experiments/sema-tax/src/schemas.js";
import { buildPublicTrialsJsonl } from "../lib/public-derivative.js";
import {
  makeSemaTaxManifest,
  makeSemaTaxTrial,
  rawProviderTranscript,
} from "./sema-tax-fixtures.js";
import { semaTaxAdapter } from "../lib/adapters/sema-tax.js";

describe("promote strip for sema-tax records", () => {
  it("removes raw provider payloads and stays schema-valid", () => {
    const withRaw = makeSemaTaxTrial({
      scenarioId: "s1",
      condition: "p16-content-warm",
      seed: 0,
      metrics: { patternCount: 16, delivery: "content", cacheState: "warm" },
      transcript: rawProviderTranscript(),
    });
    const plain = makeSemaTaxTrial({
      scenarioId: "s1",
      condition: "p0-baseline",
      seed: 1,
      metrics: {},
    });

    // Sanity: the source genuinely carries a provider chat.completion payload.
    const source = `${JSON.stringify(withRaw)}\n\n${JSON.stringify(plain)}\n`;
    expect(source).toContain("chat.completion");
    expect(source).toContain("chutes_verification");

    const output = buildPublicTrialsJsonl(source, semaTaxTrialRecordSchema);

    // No raw provider payload survives the redaction.
    expect(output).not.toContain("chat.completion");
    expect(output).not.toContain("chutes_verification");

    const lines = output.trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) =>
      semaTaxTrialRecordSchema.parse(JSON.parse(line)),
    );
    // First record's transcript raw is stripped; metrics preserved unchanged.
    expect(parsed[0]?.transcript?.entries[0]?.raw).toBeNull();
    expect(parsed[0]?.metrics).toEqual(withRaw.metrics);
    expect(parsed[1]?.transcript).toBeNull();
    expect(output.endsWith("\n")).toBe(true);
  });

  it("the adapter's redactTrials applies the same strip", () => {
    const withRaw = makeSemaTaxTrial({
      scenarioId: "s1",
      condition: "p16-content-cold",
      seed: 0,
      metrics: { patternCount: 16, delivery: "content", cacheState: "cold" },
      transcript: rawProviderTranscript(),
    });
    const output = semaTaxAdapter.redactTrials(`${JSON.stringify(withRaw)}\n`);
    expect(output).not.toContain("chat.completion");
    expect(semaTaxAdapter.experimentId).toBe("sema-tax");
  });

  it("validates a well-formed sema-tax manifest for promotion", () => {
    const manifest = semaTaxAdapter.parseManifest(makeSemaTaxManifest());
    expect(manifest.experimentId).toBe("sema-tax");
    expect(manifest.runId).toBe("20260715T103807828Z-order-20260714");
    expect(() =>
      semaTaxAdapter.parseManifest({ experimentId: "sema-tax" }),
    ).toThrow();
  });
});
