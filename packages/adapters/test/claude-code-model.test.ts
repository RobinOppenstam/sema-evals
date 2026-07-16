import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeCodeModelAdapter,
  buildClaudeCodeArgs,
  formatClaudeCodePrompt,
  runClaudeCodeProcess,
  type ClaudeCodeRunner,
  type ClaudeCodeSpawnResult,
} from "../src/claude-code-model.js";

const SYSTEM_PROMPT = "You are the planner agent. Preserve the definition.";
const STUB_PATH = fileURLToPath(
  new URL("./fixtures/claude-stub.mjs", import.meta.url),
);

const input = { messages: [{ role: "user" as const, content: "Plan this." }] };

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function argvCapturePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-code-test-"));
  tempDirs.push(dir);
  return join(dir, "argv.json");
}

function successResult(
  overrides: Partial<{
    result: string;
    stop_reason: string;
    is_error: boolean;
    usage: Record<string, number>;
    total_cost_usd: number;
  }> = {},
): string {
  return JSON.stringify({
    type: "result",
    subtype: overrides.is_error ? "error" : "success",
    is_error: overrides.is_error ?? false,
    result: overrides.result ?? "here is the plan",
    stop_reason: overrides.stop_reason ?? "end_turn",
    total_cost_usd: overrides.total_cost_usd ?? 0.00042,
    usage: overrides.usage ?? {
      input_tokens: 100,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
      output_tokens: 20,
    },
  });
}

function scriptedRunner(steps: readonly ClaudeCodeSpawnResult[]): {
  runner: ClaudeCodeRunner;
  calls: { bin: string; args: readonly string[]; timeoutMs: number }[];
} {
  const calls: { bin: string; args: readonly string[]; timeoutMs: number }[] =
    [];
  let cursor = 0;
  const runner: ClaudeCodeRunner = async (bin, args, timeoutMs) => {
    calls.push({ bin, args, timeoutMs });
    const step = steps[Math.min(cursor, steps.length - 1)];
    cursor += 1;
    if (!step) {
      throw new Error("scriptedRunner exhausted");
    }
    return step;
  };
  return { runner, calls };
}

function makeAdapter(
  runner: ClaudeCodeRunner,
  options: {
    maxRetries?: number;
    timeoutMs?: number;
    versionRunner?: () => Promise<string>;
  } = {},
): ClaudeCodeModelAdapter {
  return new ClaudeCodeModelAdapter({
    systemPrompt: SYSTEM_PROMPT,
    model: "claude-haiku-4-5",
    runner,
    sleep: async () => {},
    backoffBaseMs: 1,
    maxRetries: options.maxRetries ?? 4,
    timeoutMs: options.timeoutMs ?? 1_000,
    versionRunner: options.versionRunner ?? (async () => "2.1.211-stub"),
  });
}

describe("buildClaudeCodeArgs / formatClaudeCodePrompt", () => {
  it("builds print-mode flags with tools disabled and system prompt override", () => {
    expect(
      buildClaudeCodeArgs({
        prompt: "Plan this.",
        model: "claude-haiku-4-5",
        systemPrompt: SYSTEM_PROMPT,
      }),
    ).toEqual([
      "-p",
      "Plan this.",
      "--output-format",
      "json",
      "--model",
      "claude-haiku-4-5",
      "--system-prompt",
      SYSTEM_PROMPT,
      "--tools",
      "",
      "--no-session-persistence",
    ]);
  });

  it("passes a single user message through unchanged", () => {
    expect(formatClaudeCodePrompt(input)).toBe("Plan this.");
  });

  it("flattens multi-turn input into a labelled prompt string", () => {
    expect(
      formatClaudeCodePrompt({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "third" },
        ],
      }),
    ).toBe("[user]\nfirst\n\n[assistant]\nsecond\n\n[user]\nthird");
  });
});

describe("ClaudeCodeModelAdapter happy path", () => {
  it("maps JSON content, usage, cost, and transcript", async () => {
    const { runner } = scriptedRunner([
      {
        exitCode: 0,
        signal: null,
        stdout: successResult(),
        stderr: "",
        timedOut: false,
      },
    ]);
    const adapter = makeAdapter(runner);
    const response = await adapter.invoke(input);

    expect(adapter.descriptor.provider).toBe("claude-code");
    expect(response.output).toEqual({
      status: "completed",
      text: "here is the plan",
      stopReason: "end_turn",
    });
    expect(response.usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokensRead: 7,
      cachedInputTokensWritten: 3,
      outputTokens: 20,
      reasoningTokens: null,
      costUsd: 0.00042,
      attempts: 1,
      retries: 0,
      errors: [],
      stopReason: "end_turn",
    });
    expect(response.transcript.entries.map((entry) => entry.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(response.transcript.entries[0]?.content[0]?.text).toBe(
      SYSTEM_PROMPT,
    );
    expect(response.transcript.entries[2]?.content[0]?.text).toBe(
      "here is the plan",
    );
    expect(response.raw).toEqual(response.transcript.entries[2]?.raw);
  });

  it("constructs the expected CLI argv on each attempt", async () => {
    const { runner, calls } = scriptedRunner([
      {
        exitCode: 0,
        signal: null,
        stdout: successResult({ result: "ok" }),
        stderr: "",
        timedOut: false,
      },
    ]);
    await makeAdapter(runner).invoke(input);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(
      buildClaudeCodeArgs({
        prompt: "Plan this.",
        model: "claude-haiku-4-5",
        systemPrompt: SYSTEM_PROMPT,
      }),
    );
  });

  it("does not fabricate reasoning tokens when the CLI omits them", async () => {
    const { runner } = scriptedRunner([
      {
        exitCode: 0,
        signal: null,
        stdout: successResult({
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        stderr: "",
        timedOut: false,
      },
    ]);
    const response = await makeAdapter(runner).invoke(input);
    expect(response.usage.reasoningTokens).toBeNull();
    expect(response.usage.cachedInputTokensRead).toBe(0);
    expect(response.usage.cachedInputTokensWritten).toBe(0);
  });
});

describe("ClaudeCodeModelAdapter failure preservation", () => {
  it("preserves a nonzero exit as a non-retryable failure", async () => {
    const { runner, calls } = scriptedRunner([
      {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "stub: simulated CLI failure",
        timedOut: false,
      },
    ]);
    const response = await makeAdapter(runner).invoke(input);

    expect(calls).toHaveLength(1);
    expect(response.output).toEqual({
      status: "error",
      text: "",
      stopReason: null,
    });
    expect(response.usage.attempts).toBe(1);
    expect(response.usage.retries).toBe(0);
    expect(response.usage.errors[0]).toMatch(/exited with code 1/);
    const errorEntry = response.transcript.entries.at(-1);
    expect(errorEntry?.role).toBe("error");
    expect(errorEntry?.raw).toMatchObject({
      kind: "nonzero-exit",
      exitCode: 1,
    });
  });

  it("preserves malformed JSON as a non-retryable failure", async () => {
    const { runner, calls } = scriptedRunner([
      {
        exitCode: 0,
        signal: null,
        stdout: "not-json{{{",
        stderr: "",
        timedOut: false,
      },
    ]);
    const response = await makeAdapter(runner).invoke(input);

    expect(calls).toHaveLength(1);
    expect(response.output.status).toBe("error");
    expect(response.usage.errors[0]).toMatch(/Malformed JSON/);
    expect(response.transcript.entries.at(-1)?.raw).toMatchObject({
      kind: "malformed-json",
    });
  });

  it("retries timeouts, then succeeds, keeping every attempt", async () => {
    const { runner, calls } = scriptedRunner([
      {
        exitCode: null,
        signal: "SIGKILL",
        stdout: "",
        stderr: "",
        timedOut: true,
      },
      {
        exitCode: 0,
        signal: null,
        stdout: successResult({ result: "recovered" }),
        stderr: "",
        timedOut: false,
      },
    ]);
    const response = await makeAdapter(runner).invoke(input);

    expect(calls).toHaveLength(2);
    expect(response.output.text).toBe("recovered");
    expect(response.usage.attempts).toBe(2);
    expect(response.usage.retries).toBe(1);
    expect(response.usage.errors[0]).toMatch(/timed out/);
    expect(response.transcript.entries.map((entry) => entry.role)).toEqual([
      "system",
      "user",
      "error",
      "assistant",
    ]);
  });

  it("exhausts retries on repeated timeouts", async () => {
    const timeoutStep: ClaudeCodeSpawnResult = {
      exitCode: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      timedOut: true,
    };
    const { runner, calls } = scriptedRunner([
      timeoutStep,
      timeoutStep,
      timeoutStep,
    ]);
    const response = await makeAdapter(runner, { maxRetries: 2 }).invoke(input);

    expect(calls).toHaveLength(3);
    expect(response.output.status).toBe("error");
    expect(response.usage.attempts).toBe(3);
    expect(response.usage.retries).toBe(2);
    expect(response.usage.errors).toHaveLength(3);
  });

  it("retries a spawn error then records success", async () => {
    let call = 0;
    const runner: ClaudeCodeRunner = async () => {
      call += 1;
      if (call === 1) {
        throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: successResult({ result: "ok" }),
        stderr: "",
        timedOut: false,
      };
    };
    const response = await makeAdapter(runner).invoke(input);
    expect(call).toBe(2);
    expect(response.output.text).toBe("ok");
    expect(response.usage.errors).toEqual(["spawn EACCES"]);
  });

  it("maps is_error results to an error completion without retrying", async () => {
    const { runner, calls } = scriptedRunner([
      {
        exitCode: 0,
        signal: null,
        stdout: successResult({
          result: "blocked",
          is_error: true,
          stop_reason: "refusal",
        }),
        stderr: "",
        timedOut: false,
      },
    ]);
    const response = await makeAdapter(runner).invoke(input);
    expect(calls).toHaveLength(1);
    expect(response.output).toEqual({
      status: "error",
      text: "blocked",
      stopReason: "refusal",
    });
  });
});

describe("ClaudeCodeModelAdapter CLI version capture", () => {
  it("caches resolveCliVersion across calls", async () => {
    const versionRunner = vi
      .fn()
      .mockResolvedValueOnce("2.1.211-stub (Claude Code)");
    const adapter = makeAdapter(
      async () => ({
        exitCode: 0,
        signal: null,
        stdout: successResult(),
        stderr: "",
        timedOut: false,
      }),
      { versionRunner },
    );

    await expect(adapter.resolveCliVersion()).resolves.toBe(
      "2.1.211-stub (Claude Code)",
    );
    await expect(adapter.resolveCliVersion()).resolves.toBe(
      "2.1.211-stub (Claude Code)",
    );
    expect(versionRunner).toHaveBeenCalledTimes(1);
  });
});

describe("ClaudeCodeModelAdapter against the stub executable", () => {
  it("invokes the real stub process and maps its JSON", async () => {
    const argvPath = await argvCapturePath();
    const adapter = new ClaudeCodeModelAdapter({
      systemPrompt: SYSTEM_PROMPT,
      model: "claude-haiku-4-5",
      claudeBin: process.execPath,
      runner: async (_bin, args, timeoutMs) => {
        // Spawn node with the stub script so PATH lookup is unnecessary.
        return runClaudeCodeProcess(
          process.execPath,
          [STUB_PATH, ...args],
          timeoutMs,
        );
      },
      versionRunner: async () => {
        const result = await runClaudeCodeProcess(
          process.execPath,
          [STUB_PATH, "--version"],
          5_000,
        );
        return result.stdout.trim();
      },
      sleep: async () => {},
      maxRetries: 0,
      timeoutMs: 5_000,
    });

    // Force argv capture through the env on a direct stub spawn.
    const envRunner: ClaudeCodeRunner = async (_bin, args, timeoutMs) => {
      const previous = process.env.CLAUDE_STUB_ARGV_PATH;
      process.env.CLAUDE_STUB_ARGV_PATH = argvPath;
      try {
        return await runClaudeCodeProcess(
          process.execPath,
          [STUB_PATH, ...args],
          timeoutMs,
        );
      } finally {
        if (previous === undefined) {
          delete process.env.CLAUDE_STUB_ARGV_PATH;
        } else {
          process.env.CLAUDE_STUB_ARGV_PATH = previous;
        }
      }
    };
    const live = new ClaudeCodeModelAdapter({
      systemPrompt: SYSTEM_PROMPT,
      model: "claude-haiku-4-5",
      claudeBin: "claude-stub",
      runner: envRunner,
      versionRunner: async () => "2.1.211-stub (Claude Code)",
      sleep: async () => {},
      maxRetries: 0,
      timeoutMs: 5_000,
    });

    const response = await live.invoke(input);
    expect(response.output.text).toBe("here is the plan");
    expect(response.usage.inputTokens).toBe(100);
    expect(response.usage.costUsd).toBe(0.00042);

    const captured = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    expect(captured).toEqual(
      buildClaudeCodeArgs({
        prompt: "Plan this.",
        model: "claude-haiku-4-5",
        systemPrompt: SYSTEM_PROMPT,
      }),
    );

    await expect(adapter.resolveCliVersion()).resolves.toBe(
      "2.1.211-stub (Claude Code)",
    );
  });

  it("kills a hanging stub on timeout and preserves the failure", async () => {
    const runner: ClaudeCodeRunner = async (_bin, args, timeoutMs) => {
      const previous = process.env.CLAUDE_STUB_MODE;
      process.env.CLAUDE_STUB_MODE = "hang";
      try {
        return await runClaudeCodeProcess(
          process.execPath,
          [STUB_PATH, ...args],
          timeoutMs,
        );
      } finally {
        if (previous === undefined) {
          delete process.env.CLAUDE_STUB_MODE;
        } else {
          process.env.CLAUDE_STUB_MODE = previous;
        }
      }
    };
    const adapter = new ClaudeCodeModelAdapter({
      systemPrompt: SYSTEM_PROMPT,
      model: "claude-haiku-4-5",
      runner,
      versionRunner: async () => "2.1.211-stub",
      sleep: async () => {},
      maxRetries: 0,
      timeoutMs: 200,
    });

    const response = await adapter.invoke(input);
    expect(response.output.status).toBe("error");
    expect(response.usage.errors[0]).toMatch(/timed out after 200/);
    expect(response.transcript.entries.at(-1)?.raw).toMatchObject({
      kind: "timeout",
    });
  });

  it("preserves nonzero exit from the stub executable", async () => {
    const runner: ClaudeCodeRunner = async (_bin, args, timeoutMs) => {
      const previous = process.env.CLAUDE_STUB_MODE;
      process.env.CLAUDE_STUB_MODE = "nonzero";
      try {
        return await runClaudeCodeProcess(
          process.execPath,
          [STUB_PATH, ...args],
          timeoutMs,
        );
      } finally {
        if (previous === undefined) {
          delete process.env.CLAUDE_STUB_MODE;
        } else {
          process.env.CLAUDE_STUB_MODE = previous;
        }
      }
    };
    const response = await new ClaudeCodeModelAdapter({
      systemPrompt: SYSTEM_PROMPT,
      runner,
      versionRunner: async () => "2.1.211-stub",
      sleep: async () => {},
      maxRetries: 0,
      timeoutMs: 5_000,
    }).invoke(input);

    expect(response.output.status).toBe("error");
    expect(response.usage.errors[0]).toMatch(/exited with code 1/);
  });

  it("preserves garbage JSON from the stub executable", async () => {
    const runner: ClaudeCodeRunner = async (_bin, args, timeoutMs) => {
      const previous = process.env.CLAUDE_STUB_MODE;
      process.env.CLAUDE_STUB_MODE = "garbage";
      try {
        return await runClaudeCodeProcess(
          process.execPath,
          [STUB_PATH, ...args],
          timeoutMs,
        );
      } finally {
        if (previous === undefined) {
          delete process.env.CLAUDE_STUB_MODE;
        } else {
          process.env.CLAUDE_STUB_MODE = previous;
        }
      }
    };
    const response = await new ClaudeCodeModelAdapter({
      systemPrompt: SYSTEM_PROMPT,
      runner,
      versionRunner: async () => "2.1.211-stub",
      sleep: async () => {},
      maxRetries: 0,
      timeoutMs: 5_000,
    }).invoke(input);

    expect(response.usage.errors[0]).toMatch(/Malformed JSON/);
  });
});
