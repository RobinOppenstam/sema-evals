import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

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

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_CLAUDE_BIN = "claude";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BACKOFF_BASE_MS = 500;
const MAX_BACKOFF_MS = 8_000;
/** Per-attempt wall-clock ceiling for the Claude Code subprocess. A hung CLI
 * would otherwise block a run forever; the kill surfaces as a retryable
 * timeout error. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Preserved CLI stdout/stderr are capped so a pathological dump cannot bloat
 * a result bundle. Truncation is recorded so the record stays honest. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMBINED_OUTPUT_BYTES = 1_000_000;

/** Usage fields as reported in Claude Code `--output-format json` results. */
export interface ClaudeCodeUsagePayload {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * The subset of a Claude Code print-mode JSON result the adapter reads.
 * Discovered against Claude Code 2.1.x; unknown fields are preserved in `raw`
 * and never fabricated into telemetry.
 */
export interface ClaudeCodeResultPayload {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string | null;
  stop_reason?: string | null;
  total_cost_usd?: number | null;
  duration_ms?: number | null;
  usage?: ClaudeCodeUsagePayload | null;
  session_id?: string;
  [key: string]: unknown;
}

export interface ClaudeCodeSpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Injectable runner so unit tests never spawn the real `claude` binary. */
export type ClaudeCodeRunner = (
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  options?: { cwd?: string },
) => Promise<ClaudeCodeSpawnResult>;

export interface ClaudeCodeModelAdapterConfig {
  /** Frozen system-prompt snapshot for this run. Passed via `--system-prompt`. */
  systemPrompt: string;
  /** Path or name of the Claude Code CLI binary. Defaults to `claude`. */
  claudeBin?: string;
  /** Working directory isolated for this harness invocation. */
  workingDirectory?: string;
  model?: string;
  /**
   * Accepted for interface parity with the other providers. Claude Code print
   * mode has no max-tokens flag, so this value is never forwarded on the wire.
   */
  maxTokens?: number;
  /** Adapter-level bounded retries on timeout and spawn failures only. */
  maxRetries?: number;
  backoffBaseMs?: number;
  /** Per-attempt subprocess timeout in milliseconds. Defaults to 120_000. */
  timeoutMs?: number;
  /** Injectable runner so tests never call the real CLI. */
  runner?: ClaudeCodeRunner;
  /** Injectable version resolver; defaults to `claude --version` via the runner. */
  versionRunner?: () => Promise<string>;
  /** Injectable sleep so tests do not wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function asCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function textBlock(text: string): TranscriptBlock {
  return { type: "text", text, toolName: null, toolInput: null };
}

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

/**
 * Builds the argv for one Claude Code print-mode call. Controllable surfaces:
 * `-p` prompt, `--output-format json`, `--model`, `--system-prompt`,
 * `--tools ""` (disable tools), `--no-session-persistence`. Not controllable:
 * max_tokens, sampling params, adaptive thinking — Claude Code has no flags
 * for those on the print-mode path used here.
 */
export function buildClaudeCodeArgs(params: {
  prompt: string;
  model: string;
  systemPrompt: string;
}): string[] {
  return [
    "-p",
    params.prompt,
    "--output-format",
    "json",
    "--model",
    params.model,
    "--system-prompt",
    params.systemPrompt,
    "--tools",
    "",
    "--no-session-persistence",
  ];
}

/**
 * Flattens the adapter's ordered turns into a single `-p` prompt string.
 * Claude Code print mode accepts one prompt argument, not a Messages array.
 */
export function formatClaudeCodePrompt(input: ModelPromptInput): string {
  if (input.messages.length === 1 && input.messages[0]?.role === "user") {
    return input.messages[0].content;
  }
  return input.messages
    .map((message) => `[${message.role}]\n${message.content}`)
    .join("\n\n");
}

function completionStatus(
  stopReason: string | null,
  isError: boolean,
  hasText: boolean,
): ModelCompletionStatus {
  if (isError) {
    return "error";
  }
  if (stopReason === "refusal") {
    return "refused";
  }
  if (stopReason === "max_tokens") {
    return "truncated";
  }
  if (stopReason === "end_turn" || stopReason === "stop_sequence") {
    return "completed";
  }
  return hasText ? "completed" : "error";
}

/**
 * Spawns `bin` with `args`, kills on timeout, and returns captured streams.
 * Stdin is ignored so the CLI does not wait for piped input.
 */
export const runClaudeCodeProcess: ClaudeCodeRunner = (
  bin,
  args,
  timeoutMs,
  options,
) =>
  new Promise((resolve, reject) => {
    if (options?.cwd) {
      mkdirSync(options.cwd, { recursive: true });
    }
    const child = spawn(bin, [...args], {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMBINED_OUTPUT_BYTES) {
        timedOut = false;
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new Error("Claude Code subprocess exceeded its output limit."),
          ),
        );
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMBINED_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new Error("Claude Code subprocess exceeded its output limit."),
          ),
        );
        return;
      }
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code, signal) => {
      finish(() =>
        resolve({
          exitCode: code,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
        }),
      );
    });
  });

async function defaultVersionRunner(
  bin: string,
  runner: ClaudeCodeRunner,
  workingDirectory: string | undefined,
): Promise<string> {
  const result = await runner(bin, ["--version"], 10_000, {
    ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
  });
  if (result.timedOut) {
    throw new Error(
      `Claude Code version probe timed out after 10000 ms using ${bin}.`,
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `Claude Code version probe exited with code ${String(result.exitCode)}${
        detail ? `: ${detail}` : "."
      }`,
    );
  }
  const version = result.stdout.trim() || result.stderr.trim();
  if (!version) {
    throw new Error(
      `Claude Code version probe returned empty output from ${bin}.`,
    );
  }
  return version;
}

interface AttemptOutcome {
  entry: TranscriptEntry;
  message: string;
  raw: unknown;
}

/**
 * A transcript-preserving adapter that runs each model call as a Claude Code
 * CLI subprocess in headless print mode (`claude -p ... --output-format json`).
 * Every attempt — success or failure — is appended to the transcript; `invoke`
 * never throws for provider outcomes. Auth is ambient in the installed CLI
 * (subscription); no API key env var is read.
 */
export class ClaudeCodeModelAdapter implements ModelAgentAdapter<
  ModelPromptInput,
  ModelCompletion
> {
  public readonly descriptor: AgentDescriptor;
  public readonly systemPrompt: string;
  public readonly claudeBin: string;
  public readonly workingDirectory: string | undefined;
  public readonly model: string;
  public readonly maxTokens: number;
  public readonly maxRetries: number;
  public readonly timeoutMs: number;

  private readonly backoffBaseMs: number;
  private readonly runner: ClaudeCodeRunner;
  private readonly versionRunner: () => Promise<string>;
  private readonly sleep: (ms: number) => Promise<void>;
  private cliVersionPromise: Promise<string> | undefined;

  public constructor(config: ClaudeCodeModelAdapterConfig) {
    this.systemPrompt = config.systemPrompt;
    this.claudeBin = config.claudeBin ?? DEFAULT_CLAUDE_BIN;
    this.workingDirectory = config.workingDirectory;
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.runner = config.runner ?? runClaudeCodeProcess;
    this.versionRunner =
      config.versionRunner ??
      (() =>
        defaultVersionRunner(
          this.claudeBin,
          this.runner,
          this.workingDirectory,
        ));
    this.sleep = config.sleep ?? realSleep;
    this.descriptor = {
      id: `claude-code:${this.model}`,
      provider: "claude-code",
      model: this.model,
      deterministic: false,
    };
  }

  /**
   * Resolves and caches `claude --version` once per adapter instance. Callers
   * (the babel-relay CLI) record the result in provenance so reproducers know
   * which CLI harness sat between the prompt and the model.
   */
  public resolveCliVersion(): Promise<string> {
    this.cliVersionPromise ??= this.versionRunner().catch((error: unknown) => {
      this.cliVersionPromise = undefined;
      throw error;
    });
    return this.cliVersionPromise;
  }

  public async invoke(
    input: ModelPromptInput,
  ): Promise<ModelAgentResponse<ModelCompletion>> {
    const started = performance.now();
    const prompt = formatClaudeCodePrompt(input);
    const args = buildClaudeCodeArgs({
      prompt,
      model: this.model,
      systemPrompt: this.systemPrompt,
    });
    const entries: TranscriptEntry[] = [];
    let index = 0;

    entries.push({
      index: index++,
      attempt: 0,
      role: "system",
      content: [textBlock(this.systemPrompt)],
      raw: null,
    });
    for (const message of input.messages) {
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
      const outcome = await this.attempt(args, attempt);
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
            costUsd: outcome.costUsd,
            attempt,
            errors,
            latencyMs: performance.now() - started,
            stopReason: outcome.output.stopReason,
          }),
          started,
        });
      }

      errors.push(outcome.failure.message);
      entries.push({ ...outcome.failure.entry, index: index++ });

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
          costUsd: null,
          attempt,
          errors,
          latencyMs: performance.now() - started,
          stopReason: null,
        }),
        started,
      });
    }
  }

  private async attempt(
    args: readonly string[],
    attempt: number,
  ): Promise<
    | {
        response: true;
        output: ModelCompletion;
        usage: ClaudeCodeUsagePayload | undefined;
        costUsd: number | null;
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

    let spawnResult: ClaudeCodeSpawnResult;
    try {
      spawnResult = await this.runner(this.claudeBin, args, this.timeoutMs, {
        ...(this.workingDirectory === undefined
          ? {}
          : { cwd: this.workingDirectory }),
      });
    } catch (error) {
      const message = errorMessage(error);
      return {
        retryable: true,
        failure: entryAt(message, {
          kind: "spawn-error",
          error: { message },
          request: this.requestMeta(args),
        }),
      };
    }

    if (spawnResult.timedOut) {
      const message = `Claude Code subprocess timed out after ${this.timeoutMs} ms`;
      return {
        retryable: true,
        failure: entryAt(message, {
          kind: "timeout",
          timeoutMs: this.timeoutMs,
          stdout: capBody(spawnResult.stdout),
          stderr: capBody(spawnResult.stderr),
          request: this.requestMeta(args),
        }),
      };
    }

    if (spawnResult.exitCode !== 0) {
      const detail =
        spawnResult.stderr.trim() || spawnResult.stdout.trim() || "";
      const message = `Claude Code exited with code ${String(spawnResult.exitCode)}${
        detail ? `: ${detail.slice(0, 500)}` : ""
      }`;
      return {
        retryable: false,
        failure: entryAt(message, {
          kind: "nonzero-exit",
          exitCode: spawnResult.exitCode,
          signal: spawnResult.signal,
          stdout: capBody(spawnResult.stdout),
          stderr: capBody(spawnResult.stderr),
          request: this.requestMeta(args),
        }),
      };
    }

    const stdout = spawnResult.stdout.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      return {
        retryable: false,
        failure: entryAt(`Malformed JSON response: ${errorMessage(error)}`, {
          kind: "malformed-json",
          stdout: capBody(spawnResult.stdout),
          stderr: capBody(spawnResult.stderr),
          request: this.requestMeta(args),
        }),
      };
    }

    const root = asRecord(parsed) as ClaudeCodeResultPayload | undefined;
    if (!root) {
      return {
        retryable: false,
        failure: entryAt("Claude Code returned a non-object JSON result.", {
          kind: "malformed-json",
          response: parsed,
          request: this.requestMeta(args),
        }),
      };
    }

    const text = asString(root.result) ?? "";
    const stopReason = asString(root.stop_reason) ?? null;
    const isError = root.is_error === true;
    const usage = asRecord(root.usage) as ClaudeCodeUsagePayload | undefined;

    return {
      response: true,
      output: {
        status: completionStatus(stopReason, isError, text.length > 0),
        text,
        stopReason,
      },
      usage,
      costUsd: asCost(root.total_cost_usd),
      raw: parsed,
    };
  }

  private buildUsage(params: {
    usage: ClaudeCodeUsagePayload | undefined;
    costUsd: number | null;
    attempt: number;
    errors: readonly string[];
    latencyMs: number;
    stopReason: string | null;
  }): UsageTelemetry {
    return {
      inputTokens: asCount(params.usage?.input_tokens) ?? 0,
      cachedInputTokensRead:
        asCount(params.usage?.cache_read_input_tokens) ?? 0,
      cachedInputTokensWritten:
        asCount(params.usage?.cache_creation_input_tokens) ?? 0,
      reasoningTokens: null,
      outputTokens: asCount(params.usage?.output_tokens) ?? 0,
      attempts: params.attempt + 1,
      retries: params.attempt,
      errors: [...params.errors],
      latencyMs: params.latencyMs,
      stopReason: params.stopReason,
      costUsd: params.costUsd,
    };
  }

  private finish(params: {
    output: ModelCompletion;
    raw: unknown;
    entries: TranscriptEntry[];
    usage: UsageTelemetry;
    started: number;
  }): ModelAgentResponse<ModelCompletion> {
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

  private requestMeta(args: readonly string[]): Record<string, unknown> {
    return {
      bin: this.claudeBin,
      model: this.model,
      // Omit the full system prompt / user prompt bodies from error metadata;
      // they are already in the transcript. Args are listed without values that
      // would duplicate large prompt text: only flag names for the long ones.
      args: args.map((arg, index) => {
        const prev = args[index - 1];
        if (prev === "-p" || prev === "--system-prompt") {
          return `[${String(arg.length)} chars]`;
        }
        return arg;
      }),
    };
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.backoffBaseMs * 2 ** attempt, MAX_BACKOFF_MS);
  }
}
