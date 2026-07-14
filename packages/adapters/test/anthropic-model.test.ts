import { describe, expect, it, vi } from "vitest";

import {
  AnthropicModelAdapter,
  isRetryableModelError,
  type AnthropicMessageClient,
  type AnthropicMessageRequest,
  type AnthropicMessageResponse,
} from "../src/anthropic-model.js";

const SYSTEM_PROMPT = "You are the planner agent. Preserve the definition.";

class HttpError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly error?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function textResponse(
  text: string,
  overrides: Partial<AnthropicMessageResponse> = {},
): AnthropicMessageResponse {
  return {
    id: "msg_test",
    model: "claude-opus-4-8",
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

function adapterWith(
  create: (
    request: AnthropicMessageRequest,
  ) => Promise<AnthropicMessageResponse>,
  config: { maxRetries?: number } = {},
): {
  adapter: AnthropicModelAdapter;
  createMock: ReturnType<typeof vi.fn>;
} {
  const createMock = vi.fn(create);
  const client: AnthropicMessageClient = { messages: { create: createMock } };
  const adapter = new AnthropicModelAdapter({
    systemPrompt: SYSTEM_PROMPT,
    client,
    sleep: async () => {},
    backoffBaseMs: 1,
    maxRetries: config.maxRetries ?? 4,
  });
  return { adapter, createMock };
}

const input = { messages: [{ role: "user" as const, content: "Plan this." }] };

describe("AnthropicModelAdapter", () => {
  it("never sends sampling parameters and always requests adaptive thinking", async () => {
    const { adapter, createMock } = adapterWith(async () => textResponse("ok"));

    await adapter.invoke(input);

    const request = createMock.mock.calls[0]?.[0] as AnthropicMessageRequest;
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.system).toBe(SYSTEM_PROMPT);
    expect(request.model).toBe("claude-opus-4-8");
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
    expect(request).not.toHaveProperty("top_k");
  });

  it("preserves the system prompt, user turns, and assistant reply in order", async () => {
    const { adapter } = adapterWith(async () =>
      textResponse("here is the plan"),
    );

    const response = await adapter.invoke(input);

    expect(response.transcript.entries.map((entry) => entry.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(response.transcript.entries[0]?.content[0]?.text).toBe(
      SYSTEM_PROMPT,
    );
    expect(response.transcript.entries[1]?.content[0]?.text).toBe("Plan this.");
    expect(response.transcript.entries[2]?.content[0]?.text).toBe(
      "here is the plan",
    );
    expect(response.output).toEqual({
      status: "completed",
      text: "here is the plan",
      stopReason: "end_turn",
    });
    expect(response.raw).toEqual(response.transcript.entries[2]?.raw);
  });

  it("extracts usage telemetry including cache fields and records a thinking block", async () => {
    const { adapter } = adapterWith(async () =>
      textResponse("done", {
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "done" },
        ],
        usage: {
          input_tokens: 120,
          output_tokens: 42,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 90,
        },
      }),
    );

    const response = await adapter.invoke(input);

    expect(response.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 42,
      cachedInputTokensWritten: 30,
      cachedInputTokensRead: 90,
      reasoningTokens: null,
      costUsd: null,
      attempts: 1,
      retries: 0,
      errors: [],
      stopReason: "end_turn",
    });
    const assistant = response.transcript.entries.at(-1);
    expect(assistant?.content.map((block) => block.type)).toEqual([
      "thinking",
      "text",
    ]);
  });

  it("records a retry then success and keeps every attempt in the transcript", async () => {
    let attempts = 0;
    const { adapter } = adapterWith(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new HttpError("overloaded", 529);
      }
      return textResponse("recovered");
    });

    const response = await adapter.invoke(input);

    expect(attempts).toBe(2);
    expect(response.output.status).toBe("completed");
    expect(response.output.text).toBe("recovered");
    expect(response.usage.attempts).toBe(2);
    expect(response.usage.retries).toBe(1);
    expect(response.usage.errors).toEqual(["overloaded"]);
    expect(response.transcript.entries.map((entry) => entry.role)).toEqual([
      "system",
      "user",
      "error",
      "assistant",
    ]);
    const errorEntry = response.transcript.entries[2];
    expect(errorEntry?.attempt).toBe(0);
    expect(errorEntry?.raw).toMatchObject({ status: 529 });
  });

  it("preserves a non-retryable error as a failure with the error captured", async () => {
    const { adapter } = adapterWith(async () => {
      throw new HttpError("bad request", 400, {
        type: "invalid_request_error",
      });
    });

    const response = await adapter.invoke(input);

    expect(response.output).toEqual({
      status: "error",
      text: "",
      stopReason: null,
    });
    expect(response.usage.attempts).toBe(1);
    expect(response.usage.retries).toBe(0);
    expect(response.usage.errors).toEqual(["bad request"]);
    const errorEntry = response.transcript.entries.at(-1);
    expect(errorEntry?.role).toBe("error");
    expect(errorEntry?.raw).toMatchObject({
      status: 400,
      error: { type: "invalid_request_error" },
    });
  });

  it("stops after exhausting bounded retries and preserves each attempt", async () => {
    const { adapter, createMock } = adapterWith(
      async () => {
        throw new HttpError("still overloaded", 503);
      },
      { maxRetries: 2 },
    );

    const response = await adapter.invoke(input);

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(response.output.status).toBe("error");
    expect(response.usage.attempts).toBe(3);
    expect(response.usage.retries).toBe(2);
    expect(response.usage.errors).toHaveLength(3);
    expect(
      response.transcript.entries.filter((entry) => entry.role === "error"),
    ).toHaveLength(3);
  });

  it("preserves a refusal stop reason as a failed record", async () => {
    const { adapter } = adapterWith(async () =>
      textResponse("", { stop_reason: "refusal", content: [] }),
    );

    const response = await adapter.invoke(input);

    expect(response.output.status).toBe("refused");
    expect(response.output.stopReason).toBe("refusal");
    expect(response.usage.stopReason).toBe("refusal");
    expect(response.transcript.entries.at(-1)?.role).toBe("assistant");
  });

  it("preserves a max_tokens truncation as a failed record", async () => {
    const { adapter } = adapterWith(async () =>
      textResponse("partial", { stop_reason: "max_tokens" }),
    );

    const response = await adapter.invoke(input);

    expect(response.output.status).toBe("truncated");
    expect(response.output.text).toBe("partial");
    expect(response.usage.stopReason).toBe("max_tokens");
  });
});

describe("isRetryableModelError", () => {
  it("retries rate limits, overloads, and 5xx", () => {
    expect(isRetryableModelError(new HttpError("rate", 429))).toBe(true);
    expect(isRetryableModelError(new HttpError("overloaded", 529))).toBe(true);
    expect(isRetryableModelError(new HttpError("server", 500))).toBe(true);
  });

  it("does not retry client errors", () => {
    expect(isRetryableModelError(new HttpError("bad", 400))).toBe(false);
    expect(isRetryableModelError(new HttpError("auth", 401))).toBe(false);
    expect(isRetryableModelError(new HttpError("missing", 404))).toBe(false);
  });

  it("retries connection-style errors without a status", () => {
    const connection = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    expect(isRetryableModelError(connection)).toBe(true);
    expect(isRetryableModelError(new Error("plain bug"))).toBe(false);
  });
});
