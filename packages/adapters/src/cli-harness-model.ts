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

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const MAX_COMBINED_OUTPUT_BYTES = 1_000_000;
const MAX_CAPTURE_BYTES = 128 * 1024;

export const CLI_HARNESS_PROVIDERS = [
  "codex-cli",
  "grok-build",
  "cursor-agent",
  "opencode",
] as const;

export type CliHarnessProvider = (typeof CLI_HARNESS_PROVIDERS)[number];

export interface CliHarnessSpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CliHarnessRunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

export type CliHarnessRunner = (
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  options: CliHarnessRunOptions,
) => Promise<CliHarnessSpawnResult>;

export interface CliHarnessModelAdapterConfig {
  provider: CliHarnessProvider;
  systemPrompt: string;
  model: string;
  bin?: string;
  workingDirectory?: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  runner?: CliHarnessRunner;
  versionRunner?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface ParsedCliHarnessOutput {
  text: string;
  status: ModelCompletionStatus;
  stopReason: string | null;
  usage: Partial<UsageTelemetry>;
  raw: unknown;
}

interface CliHarnessDefinition {
  provider: CliHarnessProvider;
  defaultBin: string;
  versionArgs: readonly string[];
  systemPromptControl: "override" | "prompt-envelope";
  toolsControl: "disabled" | "read-only-agent" | "uncontrolled";
  sessionControl: "ephemeral" | "provider-managed";
  buildArgs(params: {
    prompt: string;
    systemPrompt: string;
    model: string;
    workingDirectory?: string;
  }): string[];
  environment(): Readonly<Record<string, string>>;
  parse(stdout: string): ParsedCliHarnessOutput;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRecord(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> {
  return value !== undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function textBlock(text: string): TranscriptBlock {
  return { type: "text", text, toolName: null, toolInput: null };
}

function capText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_CAPTURE_BYTES) {
    return { text, truncated: false };
  }
  return {
    text: Buffer.from(text, "utf8")
      .subarray(0, MAX_CAPTURE_BYTES)
      .toString("utf8"),
    truncated: true,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function parseJsonDocuments(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  try {
    return [JSON.parse(trimmed)];
  } catch {
    const documents: unknown[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        documents.push(JSON.parse(line));
      } catch {
        throw new Error("CLI harness returned malformed JSON/JSONL.");
      }
    }
    return documents;
  }
}

function usageFrom(
  value: unknown,
  aliases: {
    input?: readonly string[];
    cachedRead?: readonly string[];
    cachedWritten?: readonly string[];
    reasoning?: readonly string[];
    output?: readonly string[];
    attempts?: readonly string[];
    retries?: readonly string[];
    latency?: readonly string[];
    cost?: readonly string[];
  } = {},
): Partial<UsageTelemetry> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const findCount = (keys: readonly string[]): number | undefined => {
    for (const key of keys) {
      const count = asCount(record[key]);
      if (count !== undefined) {
        return count;
      }
    }
    return undefined;
  };
  const findNumber = (keys: readonly string[]): number | undefined => {
    for (const key of keys) {
      const number = asNonnegativeNumber(record[key]);
      if (number !== undefined) {
        return number;
      }
    }
    return undefined;
  };
  const inputTokens = findCount(
    aliases.input ?? ["input_tokens", "inputTokens", "prompt_tokens"],
  );
  const cachedInputTokensRead = findCount(
    aliases.cachedRead ?? [
      "cache_read_input_tokens",
      "cached_input_tokens",
      "cachedInputTokens",
      "cacheReadInputTokens",
    ],
  );
  const cachedInputTokensWritten = findCount(
    aliases.cachedWritten ?? [
      "cache_creation_input_tokens",
      "cachedInputTokensWritten",
      "cacheWriteInputTokens",
    ],
  );
  const reasoningTokens = findCount(
    aliases.reasoning ?? [
      "reasoning_tokens",
      "reasoning_output_tokens",
      "reasoningTokens",
    ],
  );
  const outputTokens = findCount(
    aliases.output ?? ["output_tokens", "outputTokens", "completion_tokens"],
  );
  const attempts = findCount(aliases.attempts ?? ["attempts", "modelCalls"]);
  const retries = findCount(aliases.retries ?? ["retries"]);
  const latencyMs = findNumber(
    aliases.latency ?? ["latency_ms", "latencyMs", "duration_ms"],
  );
  const costUsd = findNumber(
    aliases.cost ?? ["total_cost_usd", "cost_usd", "costUSD", "cost"],
  );
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokensRead === undefined ? {} : { cachedInputTokensRead }),
    ...(cachedInputTokensWritten === undefined
      ? {}
      : { cachedInputTokensWritten }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(retries === undefined ? {} : { retries }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function withDefaults(
  partial: Partial<UsageTelemetry>,
  params: {
    attempts: number;
    retries: number;
    errors: readonly string[];
    latencyMs: number;
    stopReason: string | null;
  },
): UsageTelemetry {
  return {
    inputTokens: partial.inputTokens ?? 0,
    cachedInputTokensRead: partial.cachedInputTokensRead ?? 0,
    cachedInputTokensWritten: partial.cachedInputTokensWritten ?? 0,
    reasoningTokens: partial.reasoningTokens ?? null,
    outputTokens: partial.outputTokens ?? 0,
    attempts: partial.attempts ?? params.attempts,
    retries: partial.retries ?? params.retries,
    errors: [...params.errors],
    latencyMs: partial.latencyMs ?? params.latencyMs,
    stopReason: partial.stopReason ?? params.stopReason,
    costUsd: partial.costUsd ?? null,
  };
}

function promptEnvelope(
  systemPrompt: string,
  prompt: string,
  provider: CliHarnessProvider,
): string {
  return [
    `The following is a frozen experiment instruction. Treat it as the task-specific system policy for this ${provider} harness run.`,
    "",
    "<experiment-system-prompt>",
    systemPrompt,
    "</experiment-system-prompt>",
    "",
    "<experiment-conversation>",
    prompt,
    "</experiment-conversation>",
  ].join("\n");
}

export function formatCliHarnessPrompt(input: ModelPromptInput): string {
  return input.messages
    .map((message) => `[${message.role}]\n${message.content}`)
    .join("\n\n");
}

export function buildCodexCliArgs(params: {
  prompt: string;
  model: string;
  workingDirectory?: string;
}): string[] {
  return [
    "exec",
    "--ephemeral",
    "--json",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--model",
    params.model,
    ...(params.workingDirectory ? ["--cd", params.workingDirectory] : []),
    params.prompt,
  ];
}

export function buildGrokBuildArgs(params: {
  prompt: string;
  systemPrompt: string;
  model: string;
  workingDirectory?: string;
}): string[] {
  return [
    "--single",
    params.prompt,
    "--output-format",
    "json",
    "--model",
    params.model,
    "--system-prompt-override",
    params.systemPrompt,
    "--tools",
    "",
    "--no-subagents",
    "--no-memory",
    "--disable-web-search",
    "--verbatim",
    "--max-turns",
    "1",
    "--permission-mode",
    "plan",
    ...(params.workingDirectory ? ["--cwd", params.workingDirectory] : []),
  ];
}

export function buildCursorAgentArgs(params: {
  prompt: string;
  model: string;
  workingDirectory?: string;
}): string[] {
  return [
    "--print",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--sandbox",
    "enabled",
    "--trust",
    "--model",
    params.model,
    ...(params.workingDirectory
      ? ["--workspace", params.workingDirectory]
      : []),
    params.prompt,
  ];
}

export function buildOpenCodeArgs(params: {
  prompt: string;
  model: string;
  workingDirectory?: string;
}): string[] {
  return [
    "run",
    params.prompt,
    "--format",
    "json",
    "--pure",
    "--model",
    params.model,
    ...(params.workingDirectory ? ["--dir", params.workingDirectory] : []),
  ];
}

export function parseCodexCliOutput(stdout: string): ParsedCliHarnessOutput {
  const documents = parseJsonDocuments(stdout).map(asRecord).filter(isRecord);
  let text = "";
  let terminal: Record<string, unknown> | undefined;
  let failure: Record<string, unknown> | undefined;
  for (const document of documents) {
    if (document["type"] === "item.completed") {
      const item = asRecord(document["item"]);
      if (item?.["type"] === "agent_message") {
        text = asString(item["text"]) ?? text;
      }
    }
    if (document["type"] === "turn.completed") {
      terminal = document;
    }
    if (document["type"] === "turn.failed" || document["type"] === "error") {
      failure = document;
    }
  }
  const usage = usageFrom(terminal?.["usage"]);
  return {
    text,
    status: failure ? "error" : terminal ? "completed" : "error",
    stopReason: failure
      ? (asString(failure["type"]) ?? "error")
      : terminal
        ? "turn.completed"
        : null,
    usage,
    raw: documents,
  };
}

export function parseGrokBuildOutput(stdout: string): ParsedCliHarnessOutput {
  const documents = parseJsonDocuments(stdout);
  const root = asRecord(documents.at(-1));
  if (!root) {
    throw new Error("Grok Build returned no JSON result object.");
  }
  if (root["type"] === "error") {
    return {
      text: "",
      status: "error",
      stopReason: asString(root["message"]) ?? "error",
      usage: usageFrom(root["usage"]),
      raw: root,
    };
  }
  const stopReason = asString(root["stopReason"]) ?? null;
  const normalized = stopReason?.toLowerCase() ?? "";
  const status: ModelCompletionStatus =
    normalized.includes("max") || normalized.includes("length")
      ? "truncated"
      : normalized.includes("refus")
        ? "refused"
        : "completed";
  const parsedUsage = usageFrom(root["usage"]);
  const attempts = asCount(root["num_turns"]) ?? parsedUsage.attempts;
  const costUsd = asNonnegativeNumber(root["total_cost_usd"]);
  return {
    text: asString(root["text"]) ?? "",
    status,
    stopReason,
    usage: {
      ...parsedUsage,
      ...(attempts === undefined ? {} : { attempts }),
      ...(costUsd === undefined ? {} : { costUsd }),
    },
    raw: root,
  };
}

export function parseCursorAgentOutput(stdout: string): ParsedCliHarnessOutput {
  const documents = parseJsonDocuments(stdout);
  const root = asRecord(documents.at(-1));
  if (!root) {
    throw new Error("Cursor Agent returned no JSON result object.");
  }
  const isError = asBoolean(root["is_error"]) === true;
  const subtype = asString(root["subtype"]) ?? null;
  const latencyMs =
    asNonnegativeNumber(root["duration_api_ms"]) ??
    asNonnegativeNumber(root["duration_ms"]);
  return {
    text: asString(root["result"]) ?? "",
    status: isError || subtype === "error" ? "error" : "completed",
    stopReason: subtype,
    usage: {
      ...usageFrom(root["usage"]),
      ...(latencyMs === undefined ? {} : { latencyMs }),
    },
    raw: root,
  };
}

function openCodeText(document: Record<string, unknown>): string {
  const direct =
    asString(document["text"]) ??
    asString(document["content"]) ??
    asString(document["result"]);
  if (direct) {
    return direct;
  }
  const part = asRecord(document["part"]);
  return (
    asString(part?.["text"]) ??
    asString(part?.["content"]) ??
    asString(asRecord(document["message"])?.["content"]) ??
    ""
  );
}

function openCodeUsage(value: unknown): Partial<UsageTelemetry> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const cache = asRecord(record["cache"]);
  const inputTokens = asCount(record["input"]);
  const outputTokens = asCount(record["output"]);
  const reasoningTokens = asCount(record["reasoning"]);
  const cachedInputTokensRead = asCount(cache?.["read"]);
  const cachedInputTokensWritten = asCount(cache?.["write"]);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokensRead === undefined ? {} : { cachedInputTokensRead }),
    ...(cachedInputTokensWritten === undefined
      ? {}
      : { cachedInputTokensWritten }),
    ...usageFrom(record),
  };
}

export function parseOpenCodeOutput(stdout: string): ParsedCliHarnessOutput {
  const documents = parseJsonDocuments(stdout).map(asRecord).filter(isRecord);
  const textChunks: string[] = [];
  let terminal: Record<string, unknown> | undefined;
  let failure: Record<string, unknown> | undefined;
  for (const document of documents) {
    const type = asString(document["type"]) ?? "";
    if (
      type === "text" ||
      type === "assistant" ||
      type === "message.updated" ||
      type === "message.part.updated"
    ) {
      const chunk = openCodeText(document);
      if (chunk) {
        textChunks.push(chunk);
      }
    }
    if (
      type === "step_finish" ||
      type === "step.finished" ||
      type === "session.idle" ||
      type === "result"
    ) {
      terminal = document;
    }
    if (type.includes("error") || type.includes("failed")) {
      failure = document;
    }
  }
  const terminalPart = asRecord(terminal?.["part"]);
  const usageCandidate =
    terminal?.["usage"] ?? terminalPart?.["tokens"] ?? terminalPart?.["usage"];
  const cost =
    asNonnegativeNumber(terminal?.["cost"]) ??
    asNonnegativeNumber(terminalPart?.["cost"]);
  const terminalText = terminal ? openCodeText(terminal) : "";
  const text = terminalText || textChunks.join("");
  return {
    text,
    status: failure ? "error" : terminal || text ? "completed" : "error",
    stopReason:
      asString(terminal?.["finish"]) ??
      asString(terminal?.["stopReason"]) ??
      (failure ? "error" : terminal ? "completed" : null),
    usage: {
      ...openCodeUsage(usageCandidate),
      ...(cost === undefined ? {} : { costUsd: cost }),
    },
    raw: documents,
  };
}

const DEFINITIONS: Record<CliHarnessProvider, CliHarnessDefinition> = {
  "codex-cli": {
    provider: "codex-cli",
    defaultBin: "codex",
    versionArgs: ["--version"],
    systemPromptControl: "prompt-envelope",
    toolsControl: "read-only-agent",
    sessionControl: "ephemeral",
    buildArgs: ({ prompt, model, workingDirectory }) =>
      buildCodexCliArgs({
        prompt,
        model,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      }),
    environment: () => ({}),
    parse: parseCodexCliOutput,
  },
  "grok-build": {
    provider: "grok-build",
    defaultBin: "grok",
    versionArgs: ["--version"],
    systemPromptControl: "override",
    toolsControl: "disabled",
    sessionControl: "provider-managed",
    buildArgs: ({ prompt, systemPrompt, model, workingDirectory }) =>
      buildGrokBuildArgs({
        prompt,
        systemPrompt,
        model,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      }),
    environment: () => ({}),
    parse: parseGrokBuildOutput,
  },
  "cursor-agent": {
    provider: "cursor-agent",
    defaultBin: "cursor-agent",
    versionArgs: ["--version"],
    systemPromptControl: "prompt-envelope",
    toolsControl: "read-only-agent",
    sessionControl: "provider-managed",
    buildArgs: ({ prompt, model, workingDirectory }) =>
      buildCursorAgentArgs({
        prompt,
        model,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      }),
    environment: () => ({}),
    parse: parseCursorAgentOutput,
  },
  opencode: {
    provider: "opencode",
    defaultBin: "opencode",
    versionArgs: ["--version"],
    systemPromptControl: "prompt-envelope",
    toolsControl: "disabled",
    sessionControl: "provider-managed",
    buildArgs: ({ prompt, model, workingDirectory }) =>
      buildOpenCodeArgs({
        prompt,
        model,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      }),
    environment: () => ({
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
      OPENCODE_AUTO_SHARE: "false",
      OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }),
    }),
    parse: parseOpenCodeOutput,
  },
};

export function cliHarnessDefinition(provider: CliHarnessProvider): Readonly<{
  provider: CliHarnessProvider;
  defaultBin: string;
  systemPromptControl: CliHarnessDefinition["systemPromptControl"];
  toolsControl: CliHarnessDefinition["toolsControl"];
  sessionControl: CliHarnessDefinition["sessionControl"];
}> {
  const definition = DEFINITIONS[provider];
  return {
    provider: definition.provider,
    defaultBin: definition.defaultBin,
    systemPromptControl: definition.systemPromptControl,
    toolsControl: definition.toolsControl,
    sessionControl: definition.sessionControl,
  };
}

export const runCliHarnessProcess: CliHarnessRunner = (
  bin,
  args,
  timeoutMs,
  options,
) =>
  new Promise((resolve, reject) => {
    if (options.cwd) {
      mkdirSync(options.cwd, { recursive: true });
    }
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (callback: () => void): void => {
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

    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMBINED_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() =>
          reject(new Error("CLI harness exceeded its output limit.")),
        );
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode, signal) => {
      finish(() =>
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
        }),
      );
    });
  });

interface FailureOutcome {
  retryable: boolean;
  message: string;
  raw: unknown;
}

/**
 * Subscription/agent-harness adapter shared by Codex CLI, Grok Build, Cursor
 * Agent, and OpenCode. These are intentionally recorded as distinct providers:
 * their built-in prompts, context loading, tools, and subscription routing are
 * experimental implementation effects, not interchangeable raw-model calls.
 */
export class CliHarnessModelAdapter implements ModelAgentAdapter<
  ModelPromptInput,
  ModelCompletion
> {
  public readonly descriptor: AgentDescriptor;
  public readonly provider: CliHarnessProvider;
  public readonly systemPrompt: string;
  public readonly model: string;
  public readonly bin: string;
  public readonly workingDirectory: string | undefined;
  public readonly timeoutMs: number;
  public readonly maxRetries: number;

  private readonly definition: CliHarnessDefinition;
  private readonly runner: CliHarnessRunner;
  private readonly versionRunner: () => Promise<string>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffBaseMs: number;
  private versionPromise: Promise<string> | undefined;

  public constructor(config: CliHarnessModelAdapterConfig) {
    this.definition = DEFINITIONS[config.provider];
    this.provider = config.provider;
    this.systemPrompt = config.systemPrompt;
    this.model = config.model;
    this.bin = config.bin ?? this.definition.defaultBin;
    this.workingDirectory = config.workingDirectory;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.runner = config.runner ?? runCliHarnessProcess;
    this.versionRunner = config.versionRunner ?? (() => this.probeVersion());
    this.sleep = config.sleep ?? realSleep;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.descriptor = {
      id: `${this.provider}:${this.model}`,
      provider: this.provider,
      model: this.model,
      deterministic: false,
    };
  }

  public resolveCliVersion(): Promise<string> {
    this.versionPromise ??= this.versionRunner().catch((error: unknown) => {
      this.versionPromise = undefined;
      throw error;
    });
    return this.versionPromise;
  }

  public harnessMetadata(): Record<string, string> {
    return {
      provider: this.provider,
      binary: this.bin,
      systemPromptControl: this.definition.systemPromptControl,
      toolsControl: this.definition.toolsControl,
      sessionControl: this.definition.sessionControl,
      workingDirectory: this.workingDirectory ?? process.cwd(),
    };
  }

  public async invoke(
    input: ModelPromptInput,
  ): Promise<ModelAgentResponse<ModelCompletion>> {
    const started = performance.now();
    const conversation = formatCliHarnessPrompt(input);
    const prompt =
      this.definition.systemPromptControl === "override"
        ? conversation
        : promptEnvelope(this.systemPrompt, conversation, this.provider);
    const args = this.definition.buildArgs({
      prompt,
      systemPrompt: this.systemPrompt,
      model: this.model,
      ...(this.workingDirectory === undefined
        ? {}
        : { workingDirectory: this.workingDirectory }),
    });
    const entries: TranscriptEntry[] = [
      {
        index: 0,
        attempt: 0,
        role: "system",
        content: [textBlock(this.systemPrompt)],
        raw: {
          harness: this.harnessMetadata(),
          delivery: this.definition.systemPromptControl,
        },
      },
      ...input.messages.map((message, index): TranscriptEntry => ({
        index: index + 1,
        attempt: 0,
        role: message.role,
        content: [textBlock(message.content)],
        raw: null,
      })),
    ];
    const errors: string[] = [];
    let attempt = 0;

    for (;;) {
      const outcome = await this.attempt(args);
      if (!("retryable" in outcome)) {
        entries.push({
          index: entries.length,
          attempt,
          role: "assistant",
          content: [textBlock(outcome.text)],
          raw: outcome.raw,
        });
        return {
          output: {
            status: outcome.status,
            text: outcome.text,
            stopReason: outcome.stopReason,
          },
          elapsedMs: performance.now() - started,
          raw: outcome.raw,
          transcript: { entries },
          usage: withDefaults(outcome.usage, {
            attempts: attempt + 1,
            retries: attempt,
            errors,
            latencyMs: performance.now() - started,
            stopReason: outcome.stopReason,
          }),
        };
      }

      errors.push(outcome.message);
      entries.push({
        index: entries.length,
        attempt,
        role: "error",
        content: [
          {
            type: "error",
            text: outcome.message,
            toolName: null,
            toolInput: null,
          },
        ],
        raw: outcome.raw,
      });
      if (outcome.retryable && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs(attempt));
        attempt += 1;
        continue;
      }
      const usage = withDefaults(
        {},
        {
          attempts: attempt + 1,
          retries: attempt,
          errors,
          latencyMs: performance.now() - started,
          stopReason: null,
        },
      );
      const transcript: Transcript = { entries };
      return {
        output: { status: "error", text: "", stopReason: null },
        elapsedMs: performance.now() - started,
        raw: outcome.raw,
        transcript,
        usage,
      };
    }
  }

  private async probeVersion(): Promise<string> {
    const options: CliHarnessRunOptions = {
      env: this.definition.environment(),
      ...(this.workingDirectory === undefined
        ? {}
        : { cwd: this.workingDirectory }),
    };
    const result = await this.runner(
      this.bin,
      this.definition.versionArgs,
      10_000,
      options,
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(
        `${this.provider} version probe failed using ${this.bin}.`,
      );
    }
    const version = result.stdout.trim() || result.stderr.trim();
    if (!version) {
      throw new Error(`${this.provider} version probe returned empty output.`);
    }
    return version;
  }

  private async attempt(
    args: readonly string[],
  ): Promise<ParsedCliHarnessOutput | FailureOutcome> {
    let result: CliHarnessSpawnResult;
    try {
      result = await this.runner(this.bin, args, this.timeoutMs, {
        env: this.definition.environment(),
        ...(this.workingDirectory === undefined
          ? {}
          : { cwd: this.workingDirectory }),
      });
    } catch (error) {
      const message = errorMessage(error);
      return {
        retryable: true,
        message,
        raw: {
          kind: "spawn-error",
          error: { message },
          request: this.requestMeta(args),
        },
      };
    }
    if (result.timedOut) {
      const message = `${this.provider} subprocess timed out after ${this.timeoutMs} ms`;
      return {
        retryable: true,
        message,
        raw: {
          kind: "timeout",
          stdout: capText(result.stdout),
          stderr: capText(result.stderr),
          request: this.requestMeta(args),
        },
      };
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      const message = `${this.provider} exited with code ${String(result.exitCode)}${
        detail ? `: ${detail.slice(0, 500)}` : ""
      }`;
      return {
        retryable: false,
        message,
        raw: {
          kind: "nonzero-exit",
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: capText(result.stdout),
          stderr: capText(result.stderr),
          request: this.requestMeta(args),
        },
      };
    }
    try {
      return this.definition.parse(result.stdout);
    } catch (error) {
      const message = errorMessage(error);
      return {
        retryable: false,
        message,
        raw: {
          kind: "malformed-output",
          error: { message },
          stdout: capText(result.stdout),
          stderr: capText(result.stderr),
          request: this.requestMeta(args),
        },
      };
    }
  }

  private requestMeta(args: readonly string[]): Record<string, unknown> {
    const promptFlags = new Set(["--single", "--system-prompt-override"]);
    return {
      provider: this.provider,
      bin: this.bin,
      model: this.model,
      cwd: this.workingDirectory ?? process.cwd(),
      args: args.map((arg, index) => {
        const previous = args[index - 1];
        if (
          promptFlags.has(previous ?? "") ||
          (index === args.length - 1 && arg.length > 256)
        ) {
          return `[${arg.length} chars]`;
        }
        return arg;
      }),
    };
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.backoffBaseMs * 2 ** attempt, MAX_BACKOFF_MS);
  }
}
