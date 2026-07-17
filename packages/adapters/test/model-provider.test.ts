import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_HARNESS_WORKSPACE,
  MODEL_PROVIDERS,
  createModelProvider,
  isCliHarnessProvider,
  isModelProvider,
  modelProviderRequiresApiKey,
  modelProviderSupportsMaxTokens,
  modelProviderSupportsThinking,
} from "../src/model-provider.js";

describe("shared model provider registry", () => {
  it("enumerates API and subscription harness providers", () => {
    expect(MODEL_PROVIDERS).toEqual([
      "anthropic",
      "openai-compatible",
      "claude-code",
      "codex-cli",
      "grok-build",
      "cursor-agent",
      "opencode",
    ]);
    for (const provider of MODEL_PROVIDERS) {
      expect(isModelProvider(provider)).toBe(true);
    }
  });

  it("describes provider capabilities without conflating harnesses and APIs", () => {
    expect(modelProviderRequiresApiKey("anthropic")).toBe(true);
    expect(modelProviderRequiresApiKey("codex-cli")).toBe(false);
    expect(modelProviderSupportsThinking("anthropic")).toBe(true);
    expect(modelProviderSupportsThinking("grok-build")).toBe(false);
    expect(modelProviderSupportsMaxTokens("openai-compatible")).toBe(true);
    expect(modelProviderSupportsMaxTokens("claude-code")).toBe(false);
    expect(isCliHarnessProvider("opencode")).toBe(true);
    expect(isCliHarnessProvider("claude-code")).toBe(false);
  });

  it("constructs future-experiment adapters through one factory", () => {
    const created = createModelProvider({
      provider: "grok-build",
      systemPrompt: "frozen",
      model: "grok-4.5",
      maxTokens: 4096,
      thinking: "none",
      harnessBin: "/custom/grok",
      harnessWorkingDirectory: "/tmp/harness",
    });
    expect(created.provider).toBe("grok-build");
    expect(created.adapter.descriptor).toMatchObject({
      provider: "grok-build",
      model: "grok-4.5",
    });
    expect(created.harnessMetadata).toMatchObject({
      binary: "/custom/grok",
      workingDirectory: "/tmp/harness",
      toolsControl: "disabled",
    });
  });

  it("isolates future subscription callers even when they omit a cwd", () => {
    const created = createModelProvider({
      provider: "codex-cli",
      systemPrompt: "frozen",
      model: "gpt-5.6",
      maxTokens: 4096,
      thinking: "none",
    });
    expect(created.harnessMetadata?.["workingDirectory"]).toBe(
      DEFAULT_MODEL_HARNESS_WORKSPACE,
    );
  });
});
