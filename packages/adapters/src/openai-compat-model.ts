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

const DEFAULT_API_KEY_ENV = "CHUTES_API_KEY";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BACKOFF_BASE_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** Preserved provider bodies are capped so a pathological response cannot bloat
 * a result bundle. Truncation is recorded so the record stays honest. */
const MAX_BODY_BYTES = 64 * 1024;

/** The Authorization header is never stored verbatim. */
const REDACTED_AUTHORIZATION = "Bearer [REDACTED]";

/** Usage details nested under an OpenAI-style `usage` object. */
export interface OpenAiPromptTokensDetails {
  cached_tokens?: number | null;
}

export interface OpenAiCompletionTokensDetails {
  reasoning_tokens?: number | null;
}

export interface OpenAiUsagePayload {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: OpenAiPromptTokensDetails | null;
  completion_tokens_details?: OpenAiCompletionTokensDetails | null;
}

/** The subset of a chat-completions response the adapter reads. */
export interface OpenAiChatMessage {
  role?: string;
  content?: string | null;
}

export interface OpenAiChatChoice {
  message?: OpenAiChatMessage;
  finish_reason?: string | null;
}

export interface OpenAiChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: readonly OpenAiChatChoice[];
  usage?: OpenAiUsagePayload;
}

/** The request the adapter sends. No sampling parameters are ever included,
 * matching the repo's determinism-by-prompting stance. */
export interface OpenAiChatCompletionRequest {
  model: string;
  max_tokens: number;
  messages: readonly {
    role: "system" | "user" | "assistant";
    content: string;
  }[];
}

/** The minimal response shape the adapter reads from `fetch`. The Node built-in
 * `Response` satisfies it, and a test fake can too, so no network is required. */
export interface OpenAiFetchResponse {
  status: number;
  text(): Promise<string>;
}

export interface OpenAiFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Injectable fetch so unit tests never touch the network. */
export type OpenAiFetchFn = (
  url: string,
  init: OpenAiFetchInit,
) => Promise<OpenAiFetchResponse>;

export interface OpenAiCompatibleModelAdapterConfig {
  /** Base URL of the OpenAI-compatible endpoint, e.g. `https://llm.chutes.ai/v1`. */
  baseUrl: string;
  /** Name of the env var holding the API key. The value is read lazily at the
   * first invoke and never logged or stored. Defaults to `CHUTES_API_KEY`. */
  apiKeyEnvVar?: string;
  /** Exact model slug served by the endpoint. Required; slugs vary by endpoint. */
  model: string;
  /** Frozen system-prompt snapshot for this run. */
  systemPrompt: string;
  maxTokens?: number;
  /** Adapter-level bounded retries on 429/5xx/connection failures only. */
  maxRetries?: number;
  backoffBaseMs?: number;
  /** Injectable fetch so tests never touch the network. */
  fetchFn?: OpenAiFetchFn;
  /** Injectable sleep so tests do not wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultFetch: OpenAiFetchFn = async (url, init) => fetch(url, init);

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Truncated non-negative integer, or `undefined` when the field is absent or
 * malformed. Callers coerce to `0` or `null` as the field requires. */
function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function textBlock(text: string): TranscriptBlock {
  return { type: "text", text, toolName: null, toolInput: null };
}

/** Caps a stored body to `MAX_BODY_BYTES`, noting truncation. */
function capBody(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_BODY_BYTES) {
    return { text, truncated: false };
  }
  const truncated = Buffer.from(text, "utf8")
    .subarray(0, MAX_BODY_BYTES)
    .toString("utf8");
  return { text: truncated, truncated: true };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function serializeConnectionError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (error.stack !== undefined) {
    serialized.stack = error.stack;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    serialized.code = code;
  }
  return serialized;
}

/** Retry rate-limit and 5xx responses; every other status is non-retryable. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Maps an OpenAI `finish_reason` to a completion status. `stop` completes;
 * `length` truncates; `content_filter` refuses. Any other value is preserved
 * verbatim as the stop reason and completes when text is present, otherwise it
 * is an error (an unknown terminal state with no usable content).
 */
function completionStatus(
  finishReason: string | null,
  hasText: boolean,
): ModelCompletionStatus {
  switch (finishReason) {
    case "stop":
      return "completed";
    case "length":
      return "truncated";
    case "content_filter":
      return "refused";
    default:
      return hasText ? "completed" : "error";
  }
}

interface AttemptOutcome {
  entry: TranscriptEntry;
  message: string;
  raw: unknown;
}

/**
 * A transcript-preserving adapter for any OpenAI-compatible chat-completions
 * endpoint (targets Chutes). Every attempt — success, refusal, truncation, or
 * error — is appended to the transcript in order with its raw payload, so a
 * retried or refused output is never silently dropped. `invoke` never throws
 * for provider outcomes; failures are returned as preserved records. The API
 * key is read lazily from the environment and never logged or stored: the
 * Authorization header is redacted wherever request metadata is recorded.
 */
export class OpenAiCompatibleModelAdapter implements ModelAgentAdapter<
  ModelPromptInput,
  ModelCompletion
> {
  public readonly descriptor: AgentDescriptor;
  public readonly systemPrompt: string;
  public readonly baseUrl: string;
  public readonly host: string;
  public readonly apiKeyEnvVar: string;
  public readonly model: string;
  public readonly maxTokens: number;
  public readonly maxRetries: number;

  private readonly endpoint: string;
  private readonly backoffBaseMs: number;
  private readonly fetchFn: OpenAiFetchFn;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(config: OpenAiCompatibleModelAdapterConfig) {
    if (!config.baseUrl) {
      throw new Error("OpenAiCompatibleModelAdapter requires a baseUrl.");
    }
    if (!config.model) {
      throw new Error("OpenAiCompatibleModelAdapter requires a model slug.");
    }
    this.systemPrompt = config.systemPrompt;
    this.baseUrl = stripTrailingSlashes(config.baseUrl);
    this.host = hostOf(this.baseUrl);
    this.apiKeyEnvVar = config.apiKeyEnvVar ?? DEFAULT_API_KEY_ENV;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.fetchFn = config.fetchFn ?? defaultFetch;
    this.sleep = config.sleep ?? realSleep;
    this.endpoint = `${this.baseUrl}/chat/completions`;
    this.descriptor = {
      id: `openai-compatible:${this.model}`,
      provider: this.host,
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
      if (message.role === "system") {
        continue;
      }
      entries.push({
        index: index++,
        attempt: 0,
        role: message.role,
        content: [textBlock(message.content)],
        raw: null,
      });
    }

    const apiKey = this.resolveApiKey();
    const body = JSON.stringify(request);
    const errors: string[] = [];
    let attempt = 0;

    for (;;) {
      const outcome = await this.attempt(apiKey, body, attempt);
      if ("response" in outcome) {
        entries.push({
          index: index++,
          attempt,
          role: "assistant",
          content: [textBlock(outcome.output.text)],
          raw: outcome.raw,
        });
        return this.finish({
          output: outcome.output,
          raw: outcome.raw,
          entries,
          usage: this.buildUsage({
            usage: outcome.usage,
            attempt,
            errors,
            latencyMs: performance.now() - started,
            stopReason: outcome.output.stopReason,
          }),
          started,
        });
      }

      errors.push(outcome.failure.message);
      entries.push(outcome.failure.entry);

      if (outcome.retryable && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs(attempt));
        attempt += 1;
        continue;
      }

      return this.finish({
        output: { status: "error", text: "", stopReason: null },
        raw: outcome.failure.raw,
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

  /**
   * Runs one HTTP attempt. Returns either a mapped completion (`response`) or a
   * preserved failure with its transcript entry and whether it is retryable.
   */
  private async attempt(
    apiKey: string,
    body: string,
    attempt: number,
  ): Promise<
    | {
        response: true;
        output: ModelCompletion;
        usage: OpenAiUsagePayload | undefined;
        raw: unknown;
      }
    | { retryable: boolean; failure: AttemptOutcome }
  > {
    const entryAt = (message: string, raw: unknown): AttemptOutcome => ({
      message,
      raw,
      entry: {
        index: -1,
        attempt,
        role: "error",
        content: [
          { type: "error", text: message, toolName: null, toolInput: null },
        ],
        raw,
      },
    });

    let httpResponse: OpenAiFetchResponse;
    let responseText: string;
    try {
      httpResponse = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });
      responseText = await httpResponse.text();
    } catch (error) {
      // A fetch/read rejection is a connection error: retryable.
      const message = errorMessage(error);
      return {
        retryable: true,
        failure: entryAt(message, {
          kind: "connection",
          error: serializeConnectionError(error),
          request: this.redactedRequestMeta(),
        }),
      };
    }

    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      const capped = capBody(responseText);
      const message = `HTTP ${httpResponse.status}`;
      return {
        retryable: isRetryableHttpStatus(httpResponse.status),
        failure: entryAt(message, {
          kind: "http-error",
          status: httpResponse.status,
          body: capped.text,
          bodyTruncated: capped.truncated,
          request: this.redactedRequestMeta(),
        }),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch (error) {
      // A malformed body on a 2xx is not a transient fault: non-retryable.
      const capped = capBody(responseText);
      return {
        retryable: false,
        failure: entryAt(`Malformed JSON response: ${errorMessage(error)}`, {
          kind: "malformed-json",
          status: httpResponse.status,
          body: capped.text,
          bodyTruncated: capped.truncated,
          request: this.redactedRequestMeta(),
        }),
      };
    }

    const root = asRecord(parsed);
    const choices = root?.choices;
    const choice = asRecord(Array.isArray(choices) ? choices[0] : undefined);
    if (!choice) {
      return {
        retryable: false,
        failure: entryAt("Provider response contained no choices.", {
          kind: "no-choices",
          response: parsed,
          request: this.redactedRequestMeta(),
        }),
      };
    }

    const messageRecord = asRecord(choice.message);
    const text = asString(messageRecord?.content) ?? "";
    const finishReason = asString(choice.finish_reason) ?? null;
    const usage = asRecord(root?.usage) as OpenAiUsagePayload | undefined;

    return {
      response: true,
      output: {
        status: completionStatus(finishReason, text.length > 0),
        text,
        stopReason: finishReason,
      },
      usage,
      raw: parsed,
    };
  }

  private buildRequest(input: ModelPromptInput): OpenAiChatCompletionRequest {
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        { role: "system", content: this.systemPrompt },
        ...input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
    };
  }

  private buildUsage(params: {
    usage: OpenAiUsagePayload | undefined;
    attempt: number;
    errors: readonly string[];
    latencyMs: number;
    stopReason: string | null;
  }): UsageTelemetry {
    const usage = params.usage;
    const promptDetails = asRecord(usage?.prompt_tokens_details);
    const completionDetails = asRecord(usage?.completion_tokens_details);
    return {
      inputTokens: asCount(usage?.prompt_tokens) ?? 0,
      cachedInputTokensRead: asCount(promptDetails?.cached_tokens) ?? 0,
      cachedInputTokensWritten: 0,
      reasoningTokens: asCount(completionDetails?.reasoning_tokens) ?? null,
      outputTokens: asCount(usage?.completion_tokens) ?? 0,
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
    // Reindex to keep transcript indices globally sequential regardless of how
    // many attempt entries were appended.
    const entries = params.entries.map((entry, index) => ({ ...entry, index }));
    const transcript: Transcript = { entries };
    return {
      output: params.output,
      elapsedMs: performance.now() - params.started,
      raw: params.raw,
      transcript,
      usage: params.usage,
    };
  }

  /** Request metadata safe to store: the key is replaced with a redaction. */
  private redactedRequestMeta(): Record<string, unknown> {
    return {
      method: "POST",
      url: this.endpoint,
      model: this.model,
      headers: {
        "Content-Type": "application/json",
        Authorization: REDACTED_AUTHORIZATION,
      },
    };
  }

  private resolveApiKey(): string {
    const key = process.env[this.apiKeyEnvVar];
    if (!key) {
      throw new Error(
        `${this.apiKeyEnvVar} is not set. Export it before running.`,
      );
    }
    return key;
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.backoffBaseMs * 2 ** attempt, MAX_BACKOFF_MS);
  }
}
