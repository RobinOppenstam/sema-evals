import { describe, expect, it } from "vitest";

import {
  assertProviderApiKey,
  parseArgs,
  runsModels,
  validateThinkingForModel,
} from "../src/cli.js";

describe("parseArgs", () => {
  it("defaults to the deterministic harness with the fixture backend", () => {
    const options = parseArgs([]);
    expect(options.mode).toBe("deterministic");
    expect(options.semanticBackend).toBe("fixture");
    expect(options.orderSeed).toBe(20_260_714);
    expect(options.seedCount).toBe(1);
    expect(options.concurrency).toBe(1);
    expect(options.fixturePath).toMatch(/scenarios\.yaml$/);
  });

  it("defaults model-pilot to five repetitions", () => {
    const options = parseArgs(["--mode", "model-pilot"]);
    expect(options.mode).toBe("model-pilot");
    expect(options.seedCount).toBe(5);
  });

  it("accepts --repetitions as an alias for --seeds", () => {
    expect(parseArgs(["--repetitions", "5"]).seedCount).toBe(5);
    expect(parseArgs(["--seeds", "3"]).seedCount).toBe(3);
    expect(
      parseArgs(["--mode", "model-pilot", "--repetitions", "3"]).seedCount,
    ).toBe(3);
  });

  it("accepts the sema-python backend selection", () => {
    const options = parseArgs(["--semantic-backend", "sema-python"]);
    expect(options.semanticBackend).toBe("sema-python");
  });

  it("accepts openai-compatible provider flags", () => {
    const options = parseArgs([
      "--mode",
      "model-pilot",
      "--provider",
      "openai-compatible",
      "--base-url",
      "https://llm.chutes.ai/v1",
      "--model",
      "org/model",
      "--concurrency",
      "4",
    ]);
    expect(options.provider).toBe("openai-compatible");
    expect(options.baseUrl).toBe("https://llm.chutes.ai/v1");
    expect(options.host).toBe("llm.chutes.ai");
    expect(options.model).toBe("org/model");
    expect(options.concurrency).toBe(4);
    expect(options.apiKeyEnv).toBe("CHUTES_API_KEY");
  });

  it("rejects an unknown backend", () => {
    expect(() => parseArgs(["--semantic-backend", "nope"])).toThrow(
      /fixture or sema-python/,
    );
  });

  it("rejects a non-positive seed count", () => {
    expect(() => parseArgs(["--seeds", "0"])).toThrow(/positive integer/);
  });

  it("rejects a negative order seed", () => {
    expect(() => parseArgs(["--order-seed", "-1"])).toThrow(
      /nonnegative integer/,
    );
  });

  it("rejects an unknown mode", () => {
    expect(() => parseArgs(["--mode", "confirmatory"])).toThrow(
      /deterministic or model-pilot/,
    );
  });

  it("requires --base-url and --model for openai-compatible", () => {
    expect(() =>
      parseArgs(["--mode", "model-pilot", "--provider", "openai-compatible"]),
    ).toThrow(/--base-url is required/);
    expect(() =>
      parseArgs([
        "--mode",
        "model-pilot",
        "--provider",
        "openai-compatible",
        "--base-url",
        "https://llm.chutes.ai/v1",
      ]),
    ).toThrow(/--model is required/);
  });

  it.each([
    "claude-code",
    "codex-cli",
    "grok-build",
    "cursor-agent",
    "opencode",
  ])("accepts the %s subscription harness without an API key", (provider) => {
    const args = [
      "--mode",
      "model-pilot",
      "--provider",
      provider,
      "--harness-cwd",
      "results",
    ];
    if (provider !== "claude-code") {
      args.push("--model", "provider/model");
    }
    const options = parseArgs(args);
    expect(options.provider).toBe(provider);
    expect(options.apiKeyEnv).toBe("");
    expect(options.harnessWorkingDirectory).toMatch(/results$/);
    expect(() => assertProviderApiKey(options)).not.toThrow();
  });

  it("requires an explicit model for non-Claude subscription harnesses", () => {
    expect(() => parseArgs(["--provider", "codex-cli"])).toThrow(
      /--model is required/,
    );
  });

  it("rejects an unknown argument", () => {
    expect(() => parseArgs(["--not-a-flag"])).toThrow(/Unknown argument/);
  });
});

describe("runsModels / assertProviderApiKey / validateThinkingForModel", () => {
  it("is true only for model-pilot", () => {
    expect(runsModels("deterministic")).toBe(false);
    expect(runsModels("model-pilot")).toBe(true);
  });

  it("fails fast when the API key env var is unset", () => {
    const options = parseArgs([
      "--mode",
      "model-pilot",
      "--api-key-env",
      "A2A_TEST_KEY_UNSET",
    ]);
    const previous = process.env.A2A_TEST_KEY_UNSET;
    delete process.env.A2A_TEST_KEY_UNSET;
    try {
      expect(() => assertProviderApiKey(options)).toThrow(/A2A_TEST_KEY_UNSET/);
    } finally {
      if (previous === undefined) {
        delete process.env.A2A_TEST_KEY_UNSET;
      } else {
        process.env.A2A_TEST_KEY_UNSET = previous;
      }
    }
  });

  it("rejects adaptive thinking on claude-haiku-4-5", () => {
    expect(() =>
      validateThinkingForModel("claude-haiku-4-5", "adaptive"),
    ).toThrow(/--thinking none/);
  });
});
