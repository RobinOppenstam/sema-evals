import Anthropic from "@anthropic-ai/sdk";

import type {
  Transcript,
  TranscriptBlock,
  TranscriptEntry,
  UsageTelemetry,
} from "@sema-evals/core";

import type { AgentDescriptor } from "./agent.js";
import type {
  ModelAgentAdapter,
  ModelAgentResponse,
  ModelCompletion,
  ModelCompletionStatus,
  ModelPromptInput,
} from "./model-transcript.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BACKOFF_BASE_MS = 500;
const MAX_BACKOFF_MS = 8_000;
/** Request timeout in ms passed to the SDK client. Matches the SDK default so
 * behavior is unchanged unless a run overrides it. */
const DEFAULT_TIMEOUT_MS = 600_000;

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** Usage fields as reported by the Messages API. */
export interface AnthropicUsagePayload {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** A content block on a Messages API response. */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
}

/** The subset of a Messages API response the adapter reads. */
export interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  role?: string;
  stop_reason?: string | null;
  content?: readonly AnthropicContentBlock[];
  usage?: AnthropicUsagePayload;
}

/**
 * How the adapter drives extended thinking.
 * - `adaptive` sends `thinking: { type: "adaptive" }`.
 * - `none` OMITS the `thinking` field entirely, required for models that do not
 *   support adaptive thinking (for example `claude-haiku-4-5`). `budget_tokens`
 *   and `{ type: "disabled" }` are never sent.
 */
export type AnthropicThinkingMode = "adaptive" | "none";

/** The request the adapter sends. No sampling parameters are ever included:
 * `temperature`/`top_p`/`top_k` are rejected on Opus 4.8. `thinking` is present
 * only in `adaptive` mode and omitted entirely in `none` mode. */
export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  system: string;
  thinking?: { type: "adaptive" };
  messages: readonly { role: "user" | "assistant"; content: string }[];
}

/** The minimal client the adapter drives. The real `Anthropic` client and a
 * test fake both satisfy it, so no network is required in CI. */
export interface AnthropicMessageClient {
  messages: {
    create(request: AnthropicMessageRequest): Promise<AnthropicMessageResponse>;
  };
}

export interface AnthropicModelAdapterConfig {
  /** Frozen system-prompt snapshot for this run. */
  systemPrompt: string;
  model?: string;
  maxTokens?: number;
  /** Extended-thinking mode. Defaults to `adaptive`; use `none` for models such
   * as `claude-haiku-4-5` that do not support adaptive thinking. */
  thinkingMode?: AnthropicThinkingMode;
  /** Adapter-level bounded retries (SDK retries are turned off). */
  maxRetries?: number;
  backoffBaseMs?: number;
  /** Request timeout in milliseconds passed to the SDK client at construction.
   * A timed-out request surfaces as a connection-class error and is retried
   * under the bounded-retry policy. Defaults to 600_000 (the SDK default). */
  timeoutMs?: number;
  /** Injectable client so unit tests never touch the network. */
  client?: AnthropicMessageClient;
  /** Injectable sleep so tests do not wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDefaultClient(timeoutMs: number): AnthropicMessageClient {
  const client = new Anthropic({ maxRetries: 0, timeout: timeoutMs });
  return {
    messages: {
      create: async (request) => {
        const response = await client.messages.create(
          request as unknown as Anthropic.MessageCreateParamsNonStreaming,
        );
        return response as unknown as AnthropicMessageResponse;
      },
    },
  };
}

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  return undefined;
}

function looksLikeConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (/connection|timeout|network|socket/i.test(error.name)) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code);
}

/** Retry only rate-limit, overload, 5xx, and connection failures. Everything
 * else (400, 401, 403, 404, ...) is a non-retryable failure. */
export function isRetryableModelError(error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }
  return looksLikeConnectionError(error);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (error.stack !== undefined) {
    serialized.stack = error.stack;
  }
  const status = httpStatusOf(error);
  if (status !== undefined) {
    serialized.status = status;
  }
  const body = (error as { error?: unknown }).error;
  if (body !== undefined) {
    serialized.error = body;
  }
  return serialized;
}

function nonNegativeInteger(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function textBlock(text: string): TranscriptBlock {
  return { type: "text", text, toolName: null, toolInput: null };
}

function toTranscriptBlocks(
  content: readonly AnthropicContentBlock[],
): TranscriptBlock[] {
  return content.map((block): TranscriptBlock => {
    switch (block.type) {
      case "text":
        return textBlock(block.text ?? "");
      case "thinking":
        return {
          type: "thinking",
          text: block.thinking ?? "",
          toolName: null,
          toolInput: null,
        };
      case "redacted_thinking":
        return {
          type: "redacted_thinking",
          text: null,
          toolName: null,
          toolInput: null,
        };
      case "tool_use":
        return {
          type: "tool_use",
          text: null,
          toolName: block.name ?? null,
          toolInput: block.input ?? null,
        };
      default:
        return {
          type: block.type,
          text: block.text ?? null,
          toolName: null,
          toolInput: null,
        };
    }
  });
}

function extractText(content: readonly AnthropicContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function completionStatus(stopReason: string | null): ModelCompletionStatus {
  if (stopReason === "refusal") {
    return "refused";
  }
  if (stopReason === "max_tokens") {
    return "truncated";
  }
  return "completed";
}

/**
 * A transcript-preserving Anthropic Messages adapter. Every attempt — success,
 * refusal, truncation, or error — is appended to the transcript in order, so a
 * retried or refused output can never be silently dropped. `invoke` never
 * throws for provider outcomes; failures are returned as preserved records.
 */
export class AnthropicModelAdapter implements ModelAgentAdapter<
  ModelPromptInput,
  ModelCompletion
> {
  public readonly descriptor: AgentDescriptor;
  public readonly systemPrompt: string;
  public readonly model: string;
  public readonly maxTokens: number;
  public readonly maxRetries: number;
  public readonly thinkingMode: AnthropicThinkingMode;
  public readonly timeoutMs: number;

  private readonly backoffBaseMs: number;
  private readonly injectedClient: AnthropicMessageClient | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private cachedClient: AnthropicMessageClient | undefined;

  public constructor(config: AnthropicModelAdapterConfig) {
    this.systemPrompt = config.systemPrompt;
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.thinkingMode = config.thinkingMode ?? "adaptive";
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.injectedClient = config.client;
    this.sleep = config.sleep ?? realSleep;
    this.descriptor = {
      id: `anthropic-model:${this.model}`,
      provider: "anthropic",
      model: this.model,
      deterministic: false,
    };
  }

  public async invoke(
    input: ModelPromptInput,
  ): Promise<ModelAgentResponse<ModelCompletion>> {
    const started = performance.now();
    const request = this.buildRequest(input);
    const entries: TranscriptEntry[] = [];
    let index = 0;

    entries.push({
      index: index++,
      attempt: 0,
      role: "system",
      content: [textBlock(this.systemPrompt)],
      raw: null,
    });
    for (const message of request.messages) {
      entries.push({
        index: index++,
        attempt: 0,
        role: message.role,
        content: [textBlock(message.content)],
        raw: null,
      });
    }

    const errors: string[] = [];
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.client().messages.create(request);
        const content = response.content ?? [];
        entries.push({
          index: index++,
          attempt,
          role: "assistant",
          content: toTranscriptBlocks(content),
          raw: response,
        });
        const stopReason = response.stop_reason ?? null;
        const output: ModelCompletion = {
          status: completionStatus(stopReason),
          text: extractText(content),
          stopReason,
        };
        return this.finish({
          output,
          raw: response,
          entries,
          usage: this.buildUsage({
            usage: response.usage,
            attempt,
            errors,
            latencyMs: performance.now() - started,
            stopReason,
          }),
          started,
        });
      } catch (error) {
        const message = errorMessage(error);
        errors.push(message);
        const rawError = serializeError(error);
        entries.push({
          index: index++,
          attempt,
          role: "error",
          content: [
            { type: "error", text: message, toolName: null, toolInput: null },
          ],
          raw: rawError,
        });

        if (isRetryableModelError(error) && attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt));
          attempt += 1;
          continue;
        }

        return this.finish({
          output: { status: "error", text: "", stopReason: null },
          raw: rawError,
          entries,
          usage: this.buildUsage({
            usage: undefined,
            attempt,
            errors,
            latencyMs: performance.now() - started,
            stopReason: null,
          }),
          started,
        });
      }
    }
  }

  private buildRequest(input: ModelPromptInput): AnthropicMessageRequest {
    const request: AnthropicMessageRequest = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: this.systemPrompt,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
    if (this.thinkingMode === "adaptive") {
      request.thinking = { type: "adaptive" };
    }
    return request;
  }

  private buildUsage(params: {
    usage: AnthropicUsagePayload | undefined;
    attempt: number;
    errors: readonly string[];
    latencyMs: number;
    stopReason: string | null;
  }): UsageTelemetry {
    return {
      inputTokens: nonNegativeInteger(params.usage?.input_tokens),
      cachedInputTokensRead: nonNegativeInteger(
        params.usage?.cache_read_input_tokens,
      ),
      cachedInputTokensWritten: nonNegativeInteger(
        params.usage?.cache_creation_input_tokens,
      ),
      reasoningTokens: null,
      outputTokens: nonNegativeInteger(params.usage?.output_tokens),
      attempts: params.attempt + 1,
      retries: params.attempt,
      errors: [...params.errors],
      latencyMs: params.latencyMs,
      stopReason: params.stopReason,
      costUsd: null,
    };
  }

  private finish(params: {
    output: ModelCompletion;
    raw: unknown;
    entries: TranscriptEntry[];
    usage: UsageTelemetry;
    started: number;
  }): ModelAgentResponse<ModelCompletion> {
    const transcript: Transcript = { entries: params.entries };
    return {
      output: params.output,
      elapsedMs: performance.now() - params.started,
      raw: params.raw,
      transcript,
      usage: params.usage,
    };
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.backoffBaseMs * 2 ** attempt, MAX_BACKOFF_MS);
  }

  private client(): AnthropicMessageClient {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    this.cachedClient ??= createDefaultClient(this.timeoutMs);
    return this.cachedClient;
  }
}
