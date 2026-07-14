import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OpenAiCompatibleModelAdapter,
  isRetryableHttpStatus,
  type OpenAiChatCompletionResponse,
  type OpenAiFetchInit,
  type OpenAiFetchResponse,
} from "../src/openai-compat-model.js";

const SYSTEM_PROMPT = "You are the planner agent. Preserve the definition.";
const ENV_VAR = "CHUTES_API_KEY";
const SECRET_KEY = "sk-secret-do-not-leak-0123456789abcdef";
const BASE_URL = "https://llm.chutes.ai/v1";

const input = { messages: [{ role: "user" as const, content: "Plan this." }] };

beforeEach(() => {
  process.env[ENV_VAR] = SECRET_KEY;
});

afterEach(() => {
  delete process.env[ENV_VAR];
});

function jsonResponse(
  status: number,
  body: OpenAiChatCompletionResponse | Record<string, unknown>,
): OpenAiFetchResponse {
  const text = JSON.stringify(body);
  return { status, text: async () => text };
}

function rawResponse(status: number, text: string): OpenAiFetchResponse {
  return { status, text: async () => text };
}

function completion(
  text: string,
  overrides: Partial<OpenAiChatCompletionResponse> = {},
): OpenAiChatCompletionResponse {
  return {
    id: "cmpl_test",
    model: "test-model",
    choices: [
      { message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...overrides,
  };
}

type Step = OpenAiFetchResponse | { throw: unknown };

function scriptedFetch(steps: readonly Step[]): {
  fetchFn: (url: string, init: OpenAiFetchInit) => Promise<OpenAiFetchResponse>;
  calls: { url: string; init: OpenAiFetchInit }[];
} {
  const calls: { url: string; init: OpenAiFetchInit }[] = [];
  let cursor = 0;
  const fetchFn = async (
    url: string,
    init: OpenAiFetchInit,
  ): Promise<OpenAiFetchResponse> => {
    calls.push({ url, init });
    const step = steps[Math.min(cursor, steps.length - 1)];
    cursor += 1;
    if (step && "throw" in step) {
      throw step.throw;
    }
    return step as OpenAiFetchResponse;
  };
  return { fetchFn, calls };
}

function makeAdapter(
  fetchFn: (url: string, init: OpenAiFetchInit) => Promise<OpenAiFetchResponse>,
  options: { maxRetries?: number } = {},
): OpenAiCompatibleModelAdapter {
  return new OpenAiCompatibleModelAdapter({
    systemPrompt: SYSTEM_PROMPT,
    baseUrl: BASE_URL,
    model: "test-model",
    fetchFn,
    sleep: async () => {},
    backoffBaseMs: 1,
    maxRetries: options.maxRetries ?? 4,
  });
}

describe("OpenAiCompatibleModelAdapter request", () => {
  it("posts to /chat/completions with a system message and no sampling params", async () => {
    const { fetchFn, calls } = scriptedFetch([
      jsonResponse(200, completion("ok")),
    ]);
    await makeAdapter(fetchFn).invoke(input);

    const call = calls[0];
    expect(call?.url).toBe("https://llm.chutes.ai/v1/chat/completions");
    expect(call?.init.method).toBe("POST");
    const body = JSON.parse(call?.init.body ?? "{}") as Record<string, unknown>;
    expect(body.model).toBe("test-model");
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(messages[1]).toEqual({ role: "user", content: "Plan this." });
  });

  it("throws a config error when the API key env var is unset", async () => {
    delete process.env[ENV_VAR];
    const { fetchFn } = scriptedFetch([jsonResponse(200, completion("ok"))]);
    await expect(makeAdapter(fetchFn).invoke(input)).rejects.toThrow(
      /CHUTES_API_KEY is not set/,
    );
  });
});

describe("OpenAiCompatibleModelAdapter transcript preservation", () => {
  it("preserves system, user, and assistant entries in order with raw", async () => {
    const { fetchFn } = scriptedFetch([
      jsonResponse(200, completion("here is the plan")),
    ]);
    const response = await makeAdapter(fetchFn).invoke(input);

    expect(response.transcript.entries.map((entry) => entry.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(response.transcript.entries.map((entry) => entry.index)).toEqual([
      0, 1, 2,
    ]);
    expect(response.transcript.entries[0]?.content[0]?.text).toBe(
      SYSTEM_PROMPT,
    );
    expect(response.transcript.entries[2]?.content[0]?.text).toBe(
      "here is the plan",
    );
    expect(response.output).toEqual({
      status: "completed",
      text: "here is the plan",
      stopReason: "stop",
    });
    expect(response.raw).toEqual(response.transcript.entries[2]?.raw);
  });

  it("records a retryable 503 then success, keeping every attempt", async () => {
    const { fetchFn, calls } = scriptedFetch([
      rawResponse(503, "service unavailable"),
      jsonResponse(200, completion("recovered")),
    ]);
    const response = await makeAdapter(fetchFn).invoke(input);

    expect(calls).toHaveLength(2);
    expect(response.output.status).toBe("completed");
    expect(response.output.text).toBe("recovered");
    expect(response.usage.attempts).toBe(2);
    expect(response.usage.retries).toBe(1);
    expect(response.usage.errors).toEqual(["HTTP 503"]);
    expect(response.transcript.entries.map((entry) => entry.role)).toEqual([
      "system",
      "user",
      "error",
      "assistant",
    ]);
    const errorEntry = response.transcript.entries[2];
    expect(errorEntry?.attempt).toBe(0);
    expect(errorEntry?.raw).toMatchObject({
      kind: "http-error",
      status: 503,
      body: "service unavailable",
    });
  });

  it("preserves a non-retryable 400 as a failure without retrying", async () => {
    const { fetchFn, calls } = scriptedFetch([
      jsonResponse(400, { error: { message: "bad request" } }),
    ]);
    const response = await makeAdapter(fetchFn).invoke(input);

    expect(calls).toHaveLength(1);
    expect(response.output).toEqual({
      status: "error",
      text: "",
      stopReason: null,
    });
    expect(response.usage.attempts).toBe(1);
    expect(response.usage.retries).toBe(0);
    expect(response.usage.errors).toEqual(["HTTP 400"]);
    const errorEntry = response.transcript.entries.at(-1);
    expect(errorEntry?.role).toBe("error");
    expect(errorEntry?.raw).toMatchObject({ kind: "http-error", status: 400 });
  });

  it("retries and records a fetch rejection as a connection error", async () => {
    const connection = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const { fetchFn, calls } = scriptedFetch([
      { throw: connection },
      jsonResponse(200, completion("recovered")),
    ]);
    const response = await makeAdapter(fetchFn).invoke(input);

    expect(calls).toHaveLength(2);
    expect(response.output.status).toBe("completed");
    expect(response.usage.retries).toBe(1);
    expect(response.usage.errors).toEqual(["socket hang up"]);
    const errorEntry = response.transcript.entries.find(
      (entry) => entry.role === "error",
    );
    expect(errorEntry?.raw).toMatchObject({
      kind: "connection",
      error: { code: "ECONNRESET" },
    });
  });

  it("stops after exhausting bounded retries and preserves each attempt", async () => {
    const { fetchFn, calls } = scriptedFetch([rawResponse(500, "boom")]);
    const response = await makeAdapter(fetchFn, { maxRetries: 2 }).invoke(
      input,
    );

    expect(calls).toHaveLength(3);
    expect(response.output.status).toBe("error");
    expect(response.usage.attempts).toBe(3);
    expect(response.usage.retries).toBe(2);
    expect(
      response.transcript.entries.filter((entry) => entry.role === "error"),
    ).toHaveLength(3);
  });
});

describe("OpenAiCompatibleModelAdapter finish_reason mapping", () => {
  async function statusFor(
    finishReason: string,
    content = "text",
  ): Promise<{ status: string; stopReason: string | null }> {
    const { fetchFn } = scriptedFetch([
      jsonResponse(
        200,
        completion(content, {
          choices: [
            {
              message: { role: "assistant", content },
              finish_reason: finishReason,
            },
          ],
        }),
      ),
    ]);
    const response = await makeAdapter(fetchFn).invoke(input);
    return {
      status: response.output.status,
      stopReason: response.output.stopReason,
    };
  }

  it("maps stop, length, content_filter, and unknown reasons", async () => {
    expect(await statusFor("stop")).toEqual({
      status: "completed",
      stopReason: "stop",
    });
    expect(await statusFor("length")).toEqual({
      status: "truncated",
      stopReason: "length",
    });
    expect(await statusFor("content_filter")).toEqual({
      status: "refused",
      stopReason: "content_filter",
    });
    // An unknown reason with text is preserved verbatim and completes.
    expect(await statusFor("tool_calls")).toEqual({
      status: "completed",
      stopReason: "tool_calls",
    });
    // An unknown reason with empty content is an error.
    expect(await statusFor("tool_calls", "")).toEqual({
      status: "error",
      stopReason: "tool_calls",
    });
  });
});

describe("OpenAiCompatibleModelAdapter usage mapping", () => {
  it("maps prompt/completion tokens, cached reads, and reasoning tokens", async () => {
    const { fetchFn } = scriptedFetch([
      jsonResponse(
        200,
        completion("done", {
          usage: {
            prompt_tokens: 120,
            completion_tokens: 42,
            prompt_tokens_details: { cached_tokens: 90 },
            completion_tokens_details: { reasoning_tokens: 17 },
          },
        }),
      ),
    ]);
    const response = await makeAdapter(fetchFn).invoke(input);

    expect(response.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 42,
      cachedInputTokensRead: 90,
      cachedInputTokensWritten: 0,
      reasoningTokens: 17,
      costUsd: null,
      attempts: 1,
      retries: 0,
      stopReason: "stop",
    });
  });

  it("degrades missing cached and reasoning fields to zero and null", async () => {
    const { fetchFn } = scriptedFetch([
      jsonResponse(
        200,
        completion("done", {
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
      ),
    ]);
    const response = await makeAdapter(fetchFn).invoke(input);

    expect(response.usage.cachedInputTokensRead).toBe(0);
    expect(response.usage.reasoningTokens).toBeNull();
  });

  it("degrades a missing usage object to zeros without throwing", async () => {
    const { fetchFn } = scriptedFetch([
      jsonResponse(200, {
        id: "cmpl_test",
        choices: [
          {
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          },
        ],
      }),
    ]);
    const response = await makeAdapter(fetchFn).invoke(input);

    expect(response.usage.inputTokens).toBe(0);
    expect(response.usage.outputTokens).toBe(0);
    expect(response.usage.reasoningTokens).toBeNull();
    expect(response.output.status).toBe("completed");
  });
});

describe("OpenAiCompatibleModelAdapter malformed bodies", () => {
  it("preserves a missing-choices body as a failure without throwing", async () => {
    const { fetchFn } = scriptedFetch([jsonResponse(200, { choices: [] })]);
    const response = await makeAdapter(fetchFn).invoke(input);

    expect(response.output.status).toBe("error");
    const errorEntry = response.transcript.entries.at(-1);
    expect(errorEntry?.role).toBe("error");
    expect(errorEntry?.raw).toMatchObject({ kind: "no-choices" });
  });

  it("preserves a malformed-JSON body as a non-retryable failure", async () => {
    const { fetchFn, calls } = scriptedFetch([
      rawResponse(200, "not json {{{"),
    ]);
    const response = await makeAdapter(fetchFn).invoke(input);

    expect(calls).toHaveLength(1);
    expect(response.output.status).toBe("error");
    const errorEntry = response.transcript.entries.at(-1);
    expect(errorEntry?.raw).toMatchObject({
      kind: "malformed-json",
      body: "not json {{{",
    });
  });
});

describe("OpenAiCompatibleModelAdapter key redaction", () => {
  it("uses the key in the Authorization header but never stores it", async () => {
    const { fetchFn, calls } = scriptedFetch([
      rawResponse(503, "unavailable"),
      jsonResponse(200, completion("ok")),
    ]);
    const response = await makeAdapter(fetchFn).invoke(input);

    // The real key is sent on the wire.
    expect(calls[0]?.init.headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);

    // But it never appears in the preserved record or transcript.
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(SECRET_KEY);
    // The error entry's recorded request metadata is redacted.
    expect(serialized).toContain("Bearer [REDACTED]");
  });
});

describe("OpenAiCompatibleModelAdapter timeout", () => {
  it("aborts a stalled request, records each attempt, retries, and preserves the failure", async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    let calls = 0;
    const fetchFn = (
      _url: string,
      init: OpenAiFetchInit,
    ): Promise<OpenAiFetchResponse> => {
      calls += 1;
      seenSignals.push(init.signal);
      // Never resolves on its own: only the timeout abort settles it.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
    };
    const adapter = new OpenAiCompatibleModelAdapter({
      systemPrompt: SYSTEM_PROMPT,
      baseUrl: BASE_URL,
      model: "test-model",
      fetchFn,
      sleep: async () => {},
      backoffBaseMs: 1,
      maxRetries: 2,
      timeoutMs: 5,
    });

    const response = await adapter.invoke(input);

    expect(calls).toBe(3); // initial attempt plus two bounded retries
    expect(seenSignals).toHaveLength(3);
    expect(seenSignals.every((signal) => signal instanceof AbortSignal)).toBe(
      true,
    );
    expect(response.output).toEqual({
      status: "error",
      text: "",
      stopReason: null,
    });
    expect(response.usage.attempts).toBe(3);
    expect(response.usage.retries).toBe(2);
    const errorEntries = response.transcript.entries.filter(
      (entry) => entry.role === "error",
    );
    expect(errorEntries).toHaveLength(3);
    // A timeout abort is preserved as a retryable connection-class error.
    expect(errorEntries[0]?.raw).toMatchObject({ kind: "connection" });
  });

  it("passes the timeout signal on a successful request", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchFn = async (
      _url: string,
      init: OpenAiFetchInit,
    ): Promise<OpenAiFetchResponse> => {
      capturedSignal = init.signal;
      return jsonResponse(200, completion("ok"));
    };
    await new OpenAiCompatibleModelAdapter({
      systemPrompt: SYSTEM_PROMPT,
      baseUrl: BASE_URL,
      model: "test-model",
      fetchFn,
      timeoutMs: 60_000,
    }).invoke(input);

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it("defaults timeoutMs to 120000", () => {
    const adapter = new OpenAiCompatibleModelAdapter({
      systemPrompt: SYSTEM_PROMPT,
      baseUrl: BASE_URL,
      model: "m",
    });
    expect(adapter.timeoutMs).toBe(120_000);
  });
});

describe("isRetryableHttpStatus", () => {
  it("retries 429 and 5xx, not other client errors", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });
});

// Guards against an accidental import of a live client.
it("constructs without a network client", () => {
  expect(() => {
    void new OpenAiCompatibleModelAdapter({
      systemPrompt: SYSTEM_PROMPT,
      baseUrl: BASE_URL,
      model: "m",
    });
  }).not.toThrow();
  expect(vi.isMockFunction(fetch)).toBe(false);
});
