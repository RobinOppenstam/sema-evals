import { afterEach, describe, expect, it } from "vitest";

import {
  assertProviderApiKey,
  parseArgs,
  validateThinkingForModel,
} from "../src/cli.js";

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

  it("defaults to the anthropic provider with its key env var", () => {
    const options = parseArgs([]);
    expect(options.provider).toBe("anthropic");
    expect(options.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(options.baseUrl).toBe("");
    expect(options.host).toBe("");
  });
});

describe("parseArgs arm selection", () => {
  it("defaults to the default arm and its base fixture", () => {
    const options = parseArgs([]);
    expect(options.arm).toBe("default");
    expect(options.fixturePath).toMatch(/worksheets\.yaml$/);
  });

  it("selects the size-reuse arm and its dedicated fixture", () => {
    const options = parseArgs(["--arm", "size-reuse"]);
    expect(options.arm).toBe("size-reuse");
    expect(options.fixturePath).toMatch(/worksheets-size-reuse\.yaml$/);
  });

  it("honours an explicit --fixtures over the arm default", () => {
    const options = parseArgs([
      "--arm",
      "size-reuse",
      "--fixtures",
      "experiments/sema-tax/fixtures/custom.yaml",
    ]);
    expect(options.fixturePath).toMatch(/custom\.yaml$/);
  });

  it("rejects an unknown arm", () => {
    expect(() => parseArgs(["--arm", "bogus"])).toThrow(
      /default or size-reuse/,
    );
  });
});

describe("parseArgs concurrency", () => {
  it("defaults concurrency to 1", () => {
    expect(parseArgs([]).concurrency).toBe(1);
  });

  it("reads a valid --concurrency value", () => {
    expect(parseArgs(["--concurrency", "8"]).concurrency).toBe(8);
    expect(parseArgs(["--concurrency", "32"]).concurrency).toBe(32);
  });

  it("rejects a below-minimum, above-maximum, or non-integer value", () => {
    expect(() => parseArgs(["--concurrency", "0"])).toThrow(/between 1 and 32/);
    expect(() => parseArgs(["--concurrency", "33"])).toThrow(
      /between 1 and 32/,
    );
    expect(() => parseArgs(["--concurrency", "2.5"])).toThrow(
      /between 1 and 32/,
    );
    expect(() => parseArgs(["--concurrency", "abc"])).toThrow(
      /between 1 and 32/,
    );
  });
});

describe("parseArgs provider selection", () => {
  const openaiArgs = [
    "--mode",
    "model-pilot",
    "--provider",
    "openai-compatible",
    "--base-url",
    "https://llm.chutes.ai/v1",
    "--model",
    "zai-org/GLM-4.6-FP8",
  ];

  it("accepts a complete openai-compatible invocation", () => {
    const options = parseArgs(openaiArgs);
    expect(options.provider).toBe("openai-compatible");
    expect(options.baseUrl).toBe("https://llm.chutes.ai/v1");
    expect(options.host).toBe("llm.chutes.ai");
    expect(options.apiKeyEnv).toBe("CHUTES_API_KEY");
    expect(options.model).toBe("zai-org/GLM-4.6-FP8");
  });

  it("honours --api-key-env for openai-compatible", () => {
    const options = parseArgs([...openaiArgs, "--api-key-env", "MY_KEY"]);
    expect(options.apiKeyEnv).toBe("MY_KEY");
  });

  it("requires --base-url for openai-compatible", () => {
    expect(() =>
      parseArgs(["--provider", "openai-compatible", "--model", "some/model"]),
    ).toThrow(/--base-url is required/);
  });

  it("requires --model for openai-compatible", () => {
    expect(() =>
      parseArgs([
        "--provider",
        "openai-compatible",
        "--base-url",
        "https://llm.chutes.ai/v1",
      ]),
    ).toThrow(/--model is required/);
  });

  it("rejects --thinking with openai-compatible", () => {
    expect(() => parseArgs([...openaiArgs, "--thinking", "none"])).toThrow(
      /--thinking applies only to the anthropic provider/,
    );
  });

  it("rejects an unknown provider", () => {
    expect(() => parseArgs(["--provider", "bogus"])).toThrow(
      /codex-cli.*grok-build.*cursor-agent.*opencode/,
    );
  });

  it.each([
    "claude-code",
    "codex-cli",
    "grok-build",
    "cursor-agent",
    "opencode",
  ])("accepts the %s subscription harness without an API key", (provider) => {
    const args = ["--mode", "model-pilot", "--provider", provider];
    if (provider !== "claude-code") {
      args.push("--model", "provider/model");
    }
    const options = parseArgs(args);
    expect(options.provider).toBe(provider);
    expect(options.apiKeyEnv).toBe("");
    expect(() => assertProviderApiKey(options)).not.toThrow();
  });

  it("honours generic harness binary and cwd overrides", () => {
    const options = parseArgs([
      "--provider",
      "grok-build",
      "--model",
      "grok-4.5",
      "--harness-bin",
      "/opt/grok",
      "--harness-cwd",
      "results",
    ]);
    expect(options.harnessBin).toBe("/opt/grok");
    expect(options.harnessWorkingDirectory).toMatch(/results$/);
  });
});

describe("assertProviderApiKey", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("throws when the resolved key env var is unset", () => {
    delete process.env.CHUTES_API_KEY;
    const options = parseArgs([
      "--mode",
      "model-pilot",
      "--provider",
      "openai-compatible",
      "--base-url",
      "https://llm.chutes.ai/v1",
      "--model",
      "some/model",
    ]);
    expect(() => assertProviderApiKey(options)).toThrow(/CHUTES_API_KEY/);
  });

  it("passes when the resolved key env var is present", () => {
    process.env.CHUTES_API_KEY = "sk-present";
    const options = parseArgs([
      "--mode",
      "model-pilot",
      "--provider",
      "openai-compatible",
      "--base-url",
      "https://llm.chutes.ai/v1",
      "--model",
      "some/model",
    ]);
    expect(() => assertProviderApiKey(options)).not.toThrow();
  });
});
