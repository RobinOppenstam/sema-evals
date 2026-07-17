import type {
  ModelAgentAdapter,
  ModelCompletion,
  ModelPromptInput,
} from "@sema-evals/adapters";
import type { RepositoryTaskSpec } from "@sema-evals/workflow-runner";
import { describe, expect, it } from "vitest";
import {
  executeSecurityAuditor,
  securityModelReadinessGateSchema,
} from "../src/model-executor.js";

const adapter: ModelAgentAdapter<ModelPromptInput, ModelCompletion> = {
  descriptor: {
    id: "fake",
    provider: "fake",
    model: "fake",
    deterministic: true,
  },
  invoke: async () => {
    throw new Error("must not invoke");
  },
};

describe("security model executor", () => {
  it("fails closed without invoking a model when corpus and harness are not ready", async () => {
    const result = await executeSecurityAuditor(
      adapter,
      {
        schemaVersion: "security-model-readiness-v1",
        ready: false,
        corpusReady: false,
        modelConfigured: false,
        writableHarnessVerified: false,
        repositoryExecutorWired: false,
        blockReasons: [
          "held-out-security-corpus-not-acquired",
          "model-provider-not-configured",
          "security-writable-harness-not-verified",
          "security-repository-executor-not-wired",
        ],
      },
      { task: {} as RepositoryTaskSpec, auditPrompt: "Audit this repository." },
    );
    expect(result.status).toBe("blocked");
    expect(result.transcript).toBeNull();
  });

  it("rejects inconsistent prerequisites and fingerprints without host paths", async () => {
    expect(
      securityModelReadinessGateSchema.safeParse({
        schemaVersion: "security-model-readiness-v1",
        ready: true,
        corpusReady: false,
        modelConfigured: true,
        writableHarnessVerified: true,
        repositoryExecutorWired: true,
        blockReasons: [],
      }).success,
    ).toBe(false);
    const task = {
      taskId: "t",
      snapshotDigest: "a".repeat(64),
      provenance: {},
      snapshotDirectory: "/host/a",
    } as RepositoryTaskSpec;
    const gate = {
      schemaVersion: "security-model-readiness-v1" as const,
      ready: false,
      corpusReady: true,
      modelConfigured: true,
      writableHarnessVerified: true,
      repositoryExecutorWired: false,
      blockReasons: ["security-repository-executor-not-wired"],
    };
    const first = await executeSecurityAuditor(adapter, gate, {
      task,
      auditPrompt: "audit",
    });
    const second = await executeSecurityAuditor(adapter, gate, {
      task: { ...task, snapshotDirectory: "/other/host" },
      auditPrompt: "audit",
    });
    expect(first.requestFingerprint).toBe(second.requestFingerprint);
  });
});
