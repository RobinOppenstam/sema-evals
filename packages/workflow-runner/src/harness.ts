import type { Transcript, UsageTelemetry } from "@sema-evals/core";

import type {
  RepositoryTaskSpec,
  WritableHarnessDescriptor,
  WorkflowCommand,
} from "./schemas.js";
import type { SandboxExecution } from "./sandbox.js";

export interface HarnessCheckpoint {
  checkpointId: string;
  cumulativeModelTokens: number | null;
}

export interface HarnessRunContext {
  task: RepositoryTaskSpec;
  prompt: string;
  execute(command: WorkflowCommand): Promise<SandboxExecution>;
  checkpoint(checkpoint: HarnessCheckpoint): Promise<void>;
}

export interface WritableHarnessRunResult {
  transcript: Transcript;
  usage: UsageTelemetry | null;
  completed: boolean;
  failureMessage: string | null;
}

export interface WritableHarnessAdapter {
  readonly descriptor: WritableHarnessDescriptor;
  verify(context: {
    execute(command: WorkflowCommand): Promise<SandboxExecution>;
  }): Promise<WritableHarnessDescriptor>;
  run(context: HarnessRunContext): Promise<WritableHarnessRunResult>;
}

export interface WritableHarnessInvocation {
  argv: string[];
  env: Readonly<Record<string, string>>;
}

export interface HarnessControlDeclaration {
  binary: string;
  binaryVersion: string;
  modelSelector: string;
  runnerImage: string;
  runnerImageDigest: string;
  autoUpdateDisabled: boolean;
  isolatedHome: boolean;
  userInstructionsDisabled: boolean;
  globalConfigDisabled: boolean;
  mcpDisabled: boolean;
  webToolsDisabled: boolean;
  isolationConformanceDigest?: string;
  usageTelemetry: "available" | "unavailable";
  checkpointChannel: "stream-events" | "terminal-only";
  authInjection:
    | { kind: "none" }
    | { kind: "read-only-secret"; secretSurfaceDigest: string };
  providerEndpoints: readonly string[];
  budgetChannel: WritableHarnessDescriptor["budgetChannel"];
}

function assertConformingDeclaration(
  declaration: HarnessControlDeclaration,
): void {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(declaration.runnerImageDigest) ||
    declaration.binaryVersion.trim() === "" ||
    declaration.modelSelector.trim() === ""
  ) {
    throw new Error("Writable harness version/image pin is incomplete.");
  }
}

export function buildWritableHarnessInvocation(
  provider: Exclude<
    WritableHarnessDescriptor["provider"],
    "deterministic-fake"
  >,
  declaration: HarnessControlDeclaration,
  prompt: string,
  maxTurns: number,
): WritableHarnessInvocation {
  assertConformingDeclaration(declaration);
  const commonEnv = {
    HOME: "/home/agent",
    XDG_CONFIG_HOME: "/home/agent/.config",
    NO_COLOR: "1",
    CI: "1",
  };
  switch (provider) {
    case "claude-code":
      return {
        argv: [
          declaration.binary,
          "--print",
          prompt,
          "--output-format",
          "stream-json",
          "--verbose",
          "--bare",
          "--disable-slash-commands",
          "--model",
          declaration.modelSelector,
          "--system-prompt",
          "Work only inside /workspace. Use visible repository checks. Never access the network or hidden validators.",
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          "Read,Glob,Grep,Edit,Write,Bash",
          "--disallowedTools",
          "WebFetch,WebSearch,Task,NotebookEdit,AskUserQuestion",
          "--no-session-persistence",
          "--max-turns",
          String(maxTurns),
        ],
        env: {
          ...commonEnv,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
        },
      };
    case "codex-cli":
      return {
        argv: [
          declaration.binary,
          "exec",
          "--ephemeral",
          "--json",
          "--sandbox",
          "workspace-write",
          "--ignore-user-config",
          "--ignore-rules",
          "--strict-config",
          "--disable",
          "web_search",
          "--skip-git-repo-check",
          "--model",
          declaration.modelSelector,
          "--cd",
          "/workspace",
          "-c",
          "mcp_servers={}",
          prompt,
        ],
        env: {
          ...commonEnv,
          CODEX_HOME: "/home/agent/.codex",
          CODEX_DISABLE_AUTO_UPDATE: "1",
        },
      };
    case "grok-build":
      return {
        argv: [
          declaration.binary,
          "--single",
          prompt,
          "--output-format",
          "streaming-json",
          "--model",
          declaration.modelSelector,
          "--system-prompt-override",
          "Work only inside /workspace. Use visible repository checks. Never access the network or hidden validators.",
          "--tools",
          "Read,Glob,Grep,Edit,Write,Bash",
          "--disallowed-tools",
          "WebFetch,WebSearch,Task",
          "--no-subagents",
          "--no-memory",
          "--disable-web-search",
          "--max-turns",
          String(maxTurns),
          "--permission-mode",
          "acceptEdits",
          "--cwd",
          "/workspace",
          "--verbatim",
        ],
        env: {
          ...commonEnv,
          GROK_DISABLE_AUTO_UPDATE: "1",
          GROK_SANDBOX: "workspace-write",
        },
      };
    case "cursor-agent":
      return {
        argv: [
          declaration.binary,
          "--print",
          "--output-format",
          "stream-json",
          "--sandbox",
          "enabled",
          "--trust",
          "--force",
          "--model",
          declaration.modelSelector,
          "--workspace",
          "/workspace",
          prompt,
        ],
        env: {
          ...commonEnv,
          CURSOR_HOME: "/home/agent/.cursor",
          CURSOR_DISABLE_AUTO_UPDATE: "1",
          NO_OPEN_BROWSER: "1",
        },
      };
    case "opencode":
      return {
        argv: [
          declaration.binary,
          "run",
          prompt,
          "--format",
          "json",
          "--pure",
          "--dangerously-skip-permissions",
          "--model",
          declaration.modelSelector,
          "--dir",
          "/workspace",
        ],
        env: {
          ...commonEnv,
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
          OPENCODE_DISABLE_CLAUDE_CODE: "true",
          OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true",
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
          OPENCODE_AUTO_SHARE: "false",
          OPENCODE_PERMISSION: JSON.stringify({
            "*": "allow",
            webfetch: "deny",
            websearch: "deny",
            external_directory: "deny",
          }),
        },
      };
  }
  throw new Error(`Unsupported writable harness provider: ${provider}`);
}

function transcriptFromExecution(
  prompt: string,
  execution: SandboxExecution,
): Transcript {
  return {
    entries: [
      {
        index: 0,
        attempt: 0,
        role: "user",
        content: [
          { type: "text", text: prompt, toolName: null, toolInput: null },
        ],
        raw: prompt,
      },
      {
        index: 1,
        attempt: 0,
        role: execution.ok ? "assistant" : "error",
        content: [
          {
            type: "text",
            text: execution.evidence.stdout,
            toolName: null,
            toolInput: null,
          },
          {
            type: "stderr",
            text: execution.evidence.stderr,
            toolName: null,
            toolInput: null,
          },
        ],
        raw: execution.evidence,
      },
    ],
  };
}

const UNKNOWN_USAGE: UsageTelemetry = {
  inputTokens: 0,
  cachedInputTokensRead: 0,
  cachedInputTokensWritten: 0,
  reasoningTokens: null,
  outputTokens: 0,
  attempts: 1,
  retries: 0,
  errors: [],
  latencyMs: 0,
  stopReason: null,
  costUsd: null,
};

export class CliWritableHarnessAdapter implements WritableHarnessAdapter {
  descriptor: WritableHarnessDescriptor;

  constructor(
    provider: Exclude<
      WritableHarnessDescriptor["provider"],
      "deterministic-fake"
    >,
    private readonly declaration: HarnessControlDeclaration,
  ) {
    assertConformingDeclaration(declaration);
    this.descriptor = {
      provider,
      binary: declaration.binary,
      binaryVersion: declaration.binaryVersion,
      modelSelector: declaration.modelSelector,
      runnerImage: declaration.runnerImage,
      runnerImageDigest: declaration.runnerImageDigest,
      autoUpdateDisabled: declaration.autoUpdateDisabled,
      isolatedHome: declaration.isolatedHome,
      userInstructionsDisabled: declaration.userInstructionsDisabled,
      globalConfigDisabled: declaration.globalConfigDisabled,
      mcpDisabled: declaration.mcpDisabled,
      webToolsDisabled: declaration.webToolsDisabled,
      conformanceStatus: "unverified",
      verificationDigest: null,
      blockReasons: [
        ...(declaration.isolationConformanceDigest
          ? []
          : ["missing-isolation-conformance-evidence"]),
        ...(declaration.checkpointChannel === "stream-events"
          ? []
          : ["terminal-only-checkpoints"]),
        ...(declaration.usageTelemetry === "available"
          ? []
          : ["usage-telemetry-unavailable"]),
        "adapter-stream-transcript-parser-pending",
        "adapter-live-checkpoint-channel-pending",
      ],
      usageTelemetry: declaration.usageTelemetry,
      checkpointChannel: declaration.checkpointChannel,
      authInjection: declaration.authInjection,
      budgetChannel: declaration.budgetChannel,
      providerEndpoints: [...declaration.providerEndpoints],
    };
  }

  async verify(context: {
    execute(command: WorkflowCommand): Promise<SandboxExecution>;
  }): Promise<WritableHarnessDescriptor> {
    const version = await context.execute({
      argv: [this.declaration.binary, "--version"],
      cwd: ".",
      env: {},
      timeoutMs: 10_000,
    });
    const helpArgs =
      this.descriptor.provider === "codex-cli"
        ? ["exec", "--help"]
        : this.descriptor.provider === "opencode"
          ? ["run", "--help"]
          : ["--help"];
    const help = await context.execute({
      argv: [this.declaration.binary, ...helpArgs],
      cwd: ".",
      env: {},
      timeoutMs: 10_000,
    });
    const invocation = buildWritableHarnessInvocation(
      this.descriptor.provider as Exclude<
        WritableHarnessDescriptor["provider"],
        "deterministic-fake"
      >,
      this.declaration,
      "PROBE",
      1,
    );
    const requiredFlags = [
      ...new Set(
        invocation.argv.filter((argument) => argument.startsWith("--")),
      ),
    ];
    const helpText = `${help.evidence.stdout}\n${help.evidence.stderr}`;
    const missingFlags = requiredFlags.filter(
      (flag) => !helpText.includes(flag),
    );
    const versionText = `${version.evidence.stdout}\n${version.evidence.stderr}`;
    const blockReasons = [
      ...this.descriptor.blockReasons,
      ...(version.ok && versionText.includes(this.declaration.binaryVersion)
        ? []
        : ["binary-version-probe-mismatch"]),
      ...(help.ok ? [] : ["help-probe-failed"]),
      ...missingFlags.map((flag) => `missing-cli-flag:${flag}`),
    ];
    const canVerify =
      blockReasons.length === 0 &&
      this.declaration.isolationConformanceDigest !== undefined;
    this.descriptor = {
      ...this.descriptor,
      conformanceStatus: canVerify ? "verified" : "unverified",
      verificationDigest: canVerify
        ? (this.declaration.isolationConformanceDigest ?? null)
        : null,
      blockReasons,
    };
    return this.descriptor;
  }

  async run(context: HarnessRunContext): Promise<WritableHarnessRunResult> {
    const invocation = buildWritableHarnessInvocation(
      this.descriptor.provider as Exclude<
        WritableHarnessDescriptor["provider"],
        "deterministic-fake"
      >,
      this.declaration,
      context.prompt,
      context.task.limits.maxTurns,
    );
    const execution = await context.execute({
      argv: invocation.argv,
      cwd: ".",
      env: { ...invocation.env },
      timeoutMs: context.task.limits.wallClockMs,
    });
    await context.checkpoint({
      checkpointId: "turn-0001",
      cumulativeModelTokens: null,
    });
    return {
      transcript: transcriptFromExecution(context.prompt, execution),
      usage: null,
      completed: execution.ok,
      failureMessage: execution.ok
        ? null
        : execution.evidence.stderr ||
          `Harness exited ${String(execution.evidence.exitCode)}`,
    };
  }
}

export interface DeterministicHarnessStep {
  command: WorkflowCommand;
  cumulativeModelTokens: number | null;
}

export class DeterministicWritableHarnessAdapter implements WritableHarnessAdapter {
  readonly descriptor: WritableHarnessDescriptor;

  constructor(private readonly steps: readonly DeterministicHarnessStep[]) {
    this.descriptor = {
      provider: "deterministic-fake",
      binary: "deterministic-fake",
      binaryVersion: "1.0.0",
      modelSelector: "none",
      runnerImage: "local/fake-runner:1",
      runnerImageDigest: `sha256:${"0".repeat(64)}`,
      autoUpdateDisabled: true,
      isolatedHome: true,
      userInstructionsDisabled: true,
      globalConfigDisabled: true,
      mcpDisabled: true,
      webToolsDisabled: true,
      conformanceStatus: "verified",
      verificationDigest: "0".repeat(64),
      blockReasons: [],
      usageTelemetry: "unavailable",
      checkpointChannel: "stream-events",
      authInjection: { kind: "none" },
      budgetChannel: {
        kind: "turn-wall-clock-proxy",
        maxTurns: Math.max(1, steps.length),
        maxWallClockMs: 60_000,
      },
      providerEndpoints: [],
    };
  }

  async verify(): Promise<WritableHarnessDescriptor> {
    return this.descriptor;
  }

  async run(context: HarnessRunContext): Promise<WritableHarnessRunResult> {
    const entries: Transcript["entries"] = [
      {
        index: 0,
        attempt: 0,
        role: "user",
        content: [
          {
            type: "text",
            text: context.prompt,
            toolName: null,
            toolInput: null,
          },
        ],
        raw: context.prompt,
      },
    ];
    let completed = true;
    let failureMessage: string | null = null;
    let totalDuration = 0;
    for (const [index, step] of this.steps.entries()) {
      const execution = await context.execute(step.command);
      totalDuration += execution.evidence.durationMs;
      entries.push({
        index: index + 1,
        attempt: 0,
        role: execution.ok ? "assistant" : "error",
        content: [
          {
            type: "tool-result",
            text: execution.evidence.stdout,
            toolName: step.command.argv[0] ?? null,
            toolInput: step.command.argv,
          },
        ],
        raw: execution.evidence,
      });
      await context.checkpoint({
        checkpointId: `turn-${String(index + 1).padStart(4, "0")}`,
        cumulativeModelTokens: step.cumulativeModelTokens,
      });
      if (!execution.ok) {
        completed = false;
        failureMessage =
          execution.evidence.stderr ||
          `Command exited ${String(execution.evidence.exitCode)}`;
        break;
      }
    }
    return {
      transcript: { entries },
      usage: {
        ...UNKNOWN_USAGE,
        attempts: Math.max(1, this.steps.length),
        latencyMs: totalDuration,
        errors: failureMessage ? [failureMessage] : [],
        stopReason: completed
          ? "deterministic-complete"
          : "deterministic-error",
      },
      completed,
      failureMessage,
    };
  }
}
