import { describe, expect, it } from "vitest";

import { parseArgs, validateThinkingForModel } from "../src/cli.js";

describe("validateThinkingForModel", () => {
  it("rejects adaptive thinking on claude-haiku-4-5", () => {
    expect(() =>
      validateThinkingForModel("claude-haiku-4-5", "adaptive"),
    ).toThrow(/--thinking none/);
  });

  it("accepts none on haiku and adaptive on other models", () => {
    expect(() =>
      validateThinkingForModel("claude-haiku-4-5", "none"),
    ).not.toThrow();
    expect(() =>
      validateThinkingForModel("claude-sonnet-5", "adaptive"),
    ).not.toThrow();
  });
});

describe("parseArgs", () => {
  it("defaults to deterministic mode with one seed", () => {
    const options = parseArgs([]);
    expect(options.mode).toBe("deterministic");
    expect(options.seedCount).toBe(1);
    expect(options.model).toBe("claude-sonnet-5");
    expect(options.thinking).toBe("adaptive");
    expect(options.maxTokens).toBe(4096);
  });

  it("defaults model-pilot to five repetitions", () => {
    const options = parseArgs(["--mode", "model-pilot"]);
    expect(options.mode).toBe("model-pilot");
    expect(options.seedCount).toBe(5);
  });

  it("treats --repetitions as an alias for --seeds", () => {
    expect(
      parseArgs(["--mode", "model-pilot", "--repetitions", "3"]).seedCount,
    ).toBe(3);
    expect(parseArgs(["--mode", "model-pilot", "--seeds", "7"]).seedCount).toBe(
      7,
    );
  });

  it("reads model, thinking, and max-tokens flags", () => {
    const options = parseArgs([
      "--mode",
      "model-pilot",
      "--model",
      "claude-haiku-4-5",
      "--thinking",
      "none",
      "--max-tokens",
      "1024",
    ]);
    expect(options.model).toBe("claude-haiku-4-5");
    expect(options.thinking).toBe("none");
    expect(options.maxTokens).toBe(1024);
  });

  it("fails fast when haiku is paired with adaptive thinking", () => {
    expect(() => parseArgs(["--model", "claude-haiku-4-5"])).toThrow(
      /--thinking none/,
    );
  });

  it("rejects an unknown mode or thinking mode", () => {
    expect(() => parseArgs(["--mode", "bogus"])).toThrow(
      /deterministic or model-pilot/,
    );
    expect(() => parseArgs(["--thinking", "bogus"])).toThrow(
      /adaptive or none/,
    );
  });
});
