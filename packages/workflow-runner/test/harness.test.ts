import {
  buildWritableHarnessInvocation,
  CliWritableHarnessAdapter,
  DeterministicWritableHarnessAdapter,
  type HarnessControlDeclaration,
} from "../src/harness.js";
import { describe, expect, test } from "vitest";

const declaration: HarnessControlDeclaration = {
  binary: "agent-bin",
  binaryVersion: "1.2.3",
  modelSelector: "model-id",
  runnerImage: "runner:1",
  runnerImageDigest: `sha256:${"a".repeat(64)}`,
  autoUpdateDisabled: true,
  isolatedHome: true,
  userInstructionsDisabled: true,
  globalConfigDisabled: true,
  mcpDisabled: true,
  webToolsDisabled: true,
  usageTelemetry: "unavailable",
  checkpointChannel: "terminal-only",
  authInjection: {
    kind: "read-only-secret",
    secretSurfaceDigest: "b".repeat(64),
  },
  providerEndpoints: ["provider.invalid:443"],
  budgetChannel: {
    kind: "turn-wall-clock-proxy",
    maxTurns: 3,
    maxWallClockMs: 60_000,
  },
};

describe("writable harness declarations", () => {
  test.each([
    "claude-code",
    "codex-cli",
    "grok-build",
    "cursor-agent",
    "opencode",
  ] as const)("builds an isolated writable invocation for %s", (provider) => {
    const invocation = buildWritableHarnessInvocation(
      provider,
      declaration,
      "Fix the task.",
      3,
    );
    expect(invocation.argv[0]).toBe("agent-bin");
    expect(JSON.stringify(invocation)).toContain("/workspace");
    expect(invocation.env["HOME"]).toBe("/home/agent");
  });

  test("keeps subscription adapters unverified without image conformance", () => {
    const adapter = new CliWritableHarnessAdapter("claude-code", declaration);
    expect(adapter.descriptor.conformanceStatus).toBe("unverified");
    expect(adapter.descriptor.blockReasons).toContain(
      "missing-isolation-conformance-evidence",
    );
    expect(adapter.descriptor.blockReasons).toContain(
      "adapter-live-checkpoint-channel-pending",
    );
  });

  test("marks only the deterministic fake adapter verified in CI", async () => {
    const adapter = new DeterministicWritableHarnessAdapter([]);
    expect((await adapter.verify()).conformanceStatus).toBe("verified");
  });
});
