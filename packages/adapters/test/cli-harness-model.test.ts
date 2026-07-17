import { describe, expect, it } from "vitest";

import {
  CliHarnessModelAdapter,
  buildCodexCliArgs,
  buildCursorAgentArgs,
  buildGrokBuildArgs,
  buildOpenCodeArgs,
  formatCliHarnessPrompt,
  parseCodexCliOutput,
  parseCursorAgentOutput,
  parseGrokBuildOutput,
  parseOpenCodeOutput,
  type CliHarnessRunner,
  type CliHarnessSpawnResult,
} from "../src/cli-harness-model.js";

function result(
  overrides: Partial<CliHarnessSpawnResult> = {},
): CliHarnessSpawnResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

describe("CLI harness argument construction", () => {
  it("runs Codex non-interactively with an ephemeral read-only session", () => {
    expect(
      buildCodexCliArgs({
        prompt: "task",
        model: "gpt-5.6",
        workingDirectory: "/tmp/empty",
      }),
    ).toEqual([
      "exec",
      "--ephemeral",
      "--json",
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.6",
      "--cd",
      "/tmp/empty",
      "task",
    ]);
  });

  it("locks Grok Build to one tool-free, memory-free turn", () => {
    const args = buildGrokBuildArgs({
      prompt: "task",
      systemPrompt: "system",
      model: "grok-4.5",
    });
    expect(args).toContain("--system-prompt-override");
    expect(args).toContain("--no-subagents");
    expect(args).toContain("--no-memory");
    expect(args).toContain("--disable-web-search");
    expect(args).toContain("--verbatim");
    expect(
      args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2),
    ).toEqual(["--tools", ""]);
  });

  it("runs Cursor in ask mode and OpenCode without plugins", () => {
    expect(
      buildCursorAgentArgs({ prompt: "task", model: "composer-2.5" }),
    ).toContain("ask");
    expect(
      buildOpenCodeArgs({ prompt: "task", model: "opencode/big-pickle" }),
    ).toContain("--pure");
  });

  it("preserves ordered multi-turn inputs", () => {
    expect(
      formatCliHarnessPrompt({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "third" },
        ],
      }),
    ).toBe("[user]\nfirst\n\n[assistant]\nsecond\n\n[user]\nthird");
  });
});

describe("CLI harness output parsing", () => {
  it("parses Codex JSONL final text and token usage", () => {
    const parsed = parseCodexCliOutput(
      [
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "DECISION: proceed" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 120,
            cached_input_tokens: 90,
            output_tokens: 42,
            reasoning_output_tokens: 17,
          },
        }),
      ].join("\n"),
    );
    expect(parsed).toMatchObject({
      text: "DECISION: proceed",
      status: "completed",
      stopReason: "turn.completed",
      usage: {
        inputTokens: 120,
        cachedInputTokensRead: 90,
        outputTokens: 42,
        reasoningTokens: 17,
      },
    });
  });

  it("parses Grok Build's documented headless result", () => {
    const parsed = parseGrokBuildOutput(
      JSON.stringify({
        text: "DECISION: halt",
        stopReason: "EndTurn",
        num_turns: 1,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          output_tokens: 5,
          reasoning_tokens: 2,
        },
        total_cost_usd: 0.01,
      }),
    );
    expect(parsed).toMatchObject({
      text: "DECISION: halt",
      status: "completed",
      usage: {
        inputTokens: 10,
        cachedInputTokensRead: 20,
        outputTokens: 5,
        reasoningTokens: 2,
        attempts: 1,
        costUsd: 0.01,
      },
    });
  });

  it("parses Cursor's documented JSON result without inventing tokens", () => {
    const parsed = parseCursorAgentOutput(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        result: "DECISION: proceed",
        session_id: "s1",
      }),
    );
    expect(parsed).toMatchObject({
      text: "DECISION: proceed",
      status: "completed",
      usage: { latencyMs: 1234 },
    });
    expect(parsed.usage.inputTokens).toBeUndefined();
  });

  it("parses common OpenCode raw JSON event shapes", () => {
    const parsed = parseOpenCodeOutput(
      [
        JSON.stringify({ type: "text", text: "DECISION: " }),
        JSON.stringify({ type: "text", text: "proceed" }),
        JSON.stringify({
          type: "step_finish",
          part: {
            tokens: {
              input: 15,
              output: 4,
              reasoning: 1,
              cache: { read: 9, write: 2 },
            },
            cost: 0.02,
          },
        }),
      ].join("\n"),
    );
    expect(parsed.text).toBe("DECISION: proceed");
    expect(parsed.status).toBe("completed");
    expect(parsed.usage).toMatchObject({
      inputTokens: 15,
      outputTokens: 4,
      reasoningTokens: 1,
      cachedInputTokensRead: 9,
      cachedInputTokensWritten: 2,
      costUsd: 0.02,
    });
  });
});

describe("CliHarnessModelAdapter", () => {
  it("preserves prompt, raw output, usage, and version provenance", async () => {
    const calls: Array<{ bin: string; args: readonly string[] }> = [];
    const runner: CliHarnessRunner = async (bin, args) => {
      calls.push({ bin, args });
      if (args.includes("--version")) {
        return result({ stdout: "codex-cli 0.144.5\n" });
      }
      return result({
        stdout: [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "DECISION: proceed" },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 80, output_tokens: 12 },
          }),
        ].join("\n"),
      });
    };
    const adapter = new CliHarnessModelAdapter({
      provider: "codex-cli",
      systemPrompt: "frozen system",
      model: "gpt-5.6",
      runner,
      sleep: async () => undefined,
    });

    expect(await adapter.resolveCliVersion()).toBe("codex-cli 0.144.5");
    const response = await adapter.invoke({
      messages: [{ role: "user", content: "do the task" }],
    });

    expect(response.output).toMatchObject({
      status: "completed",
      text: "DECISION: proceed",
    });
    expect(response.usage).toMatchObject({
      inputTokens: 80,
      outputTokens: 12,
      attempts: 1,
      retries: 0,
    });
    expect(response.transcript.entries.map((entry) => entry.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    const invocation = calls.at(-1);
    expect(invocation?.bin).toBe("codex");
    expect(invocation?.args.join(" ")).toContain("<experiment-system-prompt>");
  });

  it("retries timeouts and preserves every failed attempt", async () => {
    let count = 0;
    const runner: CliHarnessRunner = async () => {
      count += 1;
      if (count === 1) {
        return result({ timedOut: true });
      }
      return result({
        stdout: JSON.stringify({
          text: "DECISION: proceed",
          stopReason: "EndTurn",
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      });
    };
    const adapter = new CliHarnessModelAdapter({
      provider: "grok-build",
      systemPrompt: "system",
      model: "grok-4.5",
      runner,
      maxRetries: 1,
      sleep: async () => undefined,
    });
    const response = await adapter.invoke({
      messages: [{ role: "user", content: "task" }],
    });
    expect(response.output.status).toBe("completed");
    expect(response.usage).toMatchObject({ attempts: 2, retries: 1 });
    expect(response.usage.errors).toHaveLength(1);
    expect(
      response.transcript.entries.some((entry) => entry.role === "error"),
    ).toBe(true);
  });

  it("preserves nonzero exits as terminal adapter failures", async () => {
    const adapter = new CliHarnessModelAdapter({
      provider: "cursor-agent",
      systemPrompt: "system",
      model: "composer",
      maxRetries: 0,
      runner: async () =>
        result({ exitCode: 1, stderr: "subscription unavailable" }),
    });
    const response = await adapter.invoke({
      messages: [{ role: "user", content: "task" }],
    });
    expect(response.output.status).toBe("error");
    expect(response.usage.errors[0]).toMatch(/subscription unavailable/);
    expect(response.transcript.entries.at(-1)?.role).toBe("error");
  });
});
