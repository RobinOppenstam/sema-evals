import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ModelAgentAdapter,
  ModelCompletion,
  ModelPromptInput,
} from "./model-transcript.js";
import {
  AnthropicModelAdapter,
  type AnthropicThinkingMode,
} from "./anthropic-model.js";
import { ClaudeCodeModelAdapter } from "./claude-code-model.js";
import {
  CLI_HARNESS_PROVIDERS,
  CliHarnessModelAdapter,
  type CliHarnessProvider,
} from "./cli-harness-model.js";
import { OpenAiCompatibleModelAdapter } from "./openai-compat-model.js";

export const MODEL_PROVIDERS = [
  "anthropic",
  "openai-compatible",
  "claude-code",
  ...CLI_HARNESS_PROVIDERS,
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export const MODEL_PROVIDER_NAMES = MODEL_PROVIDERS.join(", ");
export const DEFAULT_MODEL_HARNESS_WORKSPACE = join(
  tmpdir(),
  "sema-evals-harness",
);

export interface ModelProviderConfig {
  provider: ModelProvider;
  systemPrompt: string;
  model: string;
  maxTokens: number;
  thinking: AnthropicThinkingMode;
  baseUrl?: string;
  apiKeyEnv?: string;
  harnessBin?: string;
  harnessWorkingDirectory?: string;
}

export interface CreatedModelProvider {
  adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion>;
  provider: ModelProvider;
  providerLabel(): Promise<string>;
  harnessMetadata: Readonly<Record<string, string>> | null;
}

export function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export function isCliHarnessProvider(
  provider: ModelProvider,
): provider is CliHarnessProvider {
  return (CLI_HARNESS_PROVIDERS as readonly string[]).includes(provider);
}

export function isSubscriptionHarnessProvider(
  provider: ModelProvider,
): boolean {
  return provider === "claude-code" || isCliHarnessProvider(provider);
}

export function modelProviderRequiresApiKey(provider: ModelProvider): boolean {
  return provider === "anthropic" || provider === "openai-compatible";
}

export function modelProviderSupportsThinking(
  provider: ModelProvider,
): boolean {
  return provider === "anthropic";
}

export function modelProviderSupportsMaxTokens(
  provider: ModelProvider,
): boolean {
  return provider === "anthropic" || provider === "openai-compatible";
}

export function createModelProvider(
  config: ModelProviderConfig,
): CreatedModelProvider {
  if (config.provider === "openai-compatible") {
    if (!config.baseUrl || !config.apiKeyEnv) {
      throw new Error(
        "openai-compatible requires baseUrl and apiKeyEnv configuration.",
      );
    }
    const adapter = new OpenAiCompatibleModelAdapter({
      systemPrompt: config.systemPrompt,
      baseUrl: config.baseUrl,
      apiKeyEnvVar: config.apiKeyEnv,
      model: config.model,
      maxTokens: config.maxTokens,
    });
    return {
      adapter,
      provider: config.provider,
      providerLabel: async () => new URL(config.baseUrl ?? "").host,
      harnessMetadata: null,
    };
  }
  if (config.provider === "anthropic") {
    const adapter = new AnthropicModelAdapter({
      systemPrompt: config.systemPrompt,
      model: config.model,
      maxTokens: config.maxTokens,
      thinkingMode: config.thinking,
    });
    return {
      adapter,
      provider: config.provider,
      providerLabel: async () => "anthropic",
      harnessMetadata: null,
    };
  }
  if (config.provider === "claude-code") {
    const harnessWorkingDirectory =
      config.harnessWorkingDirectory ?? DEFAULT_MODEL_HARNESS_WORKSPACE;
    const adapter = new ClaudeCodeModelAdapter({
      systemPrompt: config.systemPrompt,
      model: config.model,
      maxTokens: config.maxTokens,
      ...(config.harnessBin === undefined
        ? {}
        : { claudeBin: config.harnessBin }),
      workingDirectory: harnessWorkingDirectory,
    });
    return {
      adapter,
      provider: config.provider,
      providerLabel: async () =>
        `claude-code@${await adapter.resolveCliVersion()}`,
      harnessMetadata: {
        provider: "claude-code",
        binary: config.harnessBin ?? "claude",
        systemPromptControl: "override",
        toolsControl: "disabled",
        sessionControl: "no-session-persistence",
        workingDirectory: harnessWorkingDirectory,
      },
    };
  }
  const harnessWorkingDirectory =
    config.harnessWorkingDirectory ?? DEFAULT_MODEL_HARNESS_WORKSPACE;
  const adapter = new CliHarnessModelAdapter({
    provider: config.provider,
    systemPrompt: config.systemPrompt,
    model: config.model,
    ...(config.harnessBin === undefined ? {} : { bin: config.harnessBin }),
    workingDirectory: harnessWorkingDirectory,
  });
  return {
    adapter,
    provider: config.provider,
    providerLabel: async () =>
      `${config.provider}@${await adapter.resolveCliVersion()}`,
    harnessMetadata: adapter.harnessMetadata(),
  };
}
