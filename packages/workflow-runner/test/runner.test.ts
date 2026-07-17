import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  DeterministicWritableHarnessAdapter,
  type DeterministicHarnessStep,
} from "../src/harness.js";
import { AgentWorkflowRunner } from "../src/runner.js";
import type { RepositoryTaskSpec } from "../src/schemas.js";
import { digestTree, sha256 } from "../src/tree.js";
import { FakeSandboxDriver } from "./fake-sandbox.js";

async function fixture(): Promise<{
  root: string;
  task: RepositoryTaskSpec;
}> {
  const root = await mkdtemp(join(tmpdir(), "workflow-runner-test-"));
  const snapshot = join(root, "snapshot");
  const validator = join(root, "hidden-validator.mjs");
  await mkdir(join(snapshot, "src"), { recursive: true });
  await writeFile(
    join(snapshot, "src", "value.js"),
    "export default 'wrong';\n",
  );
  const validatorSource = [
    "import { readFileSync } from 'node:fs';",
    "const value = readFileSync(new URL('./src/value.js', `file://${process.cwd()}/`), 'utf8');",
    "process.exit(value.includes(\"'right'\") ? 0 : 3);",
  ].join("\n");
  await writeFile(validator, validatorSource);
  const task: RepositoryTaskSpec = {
    schemaVersion: "workflow-repository-task-v1",
    taskId: "fix-value",
    snapshotDirectory: snapshot,
    snapshotDigest: await digestTree(snapshot),
    taskRequest: "Correct the exported value and preserve the module shape.",
    setupCommand: null,
    visibleChecks: [
      {
        argv: [
          process.execPath,
          "-e",
          "const fs=require('fs');process.exit(fs.readFileSync('src/value.js','utf8').includes('export default')?0:2)",
        ],
        cwd: ".",
        env: {},
        timeoutMs: 2_000,
      },
    ],
    hiddenValidator: {
      argv: [process.execPath, validator],
      cwd: ".",
      env: {},
      timeoutMs: 2_000,
    },
    hiddenValidatorSourcePath: validator,
    hiddenValidatorSourceDigest: sha256(validatorSource),
    offlineDependencyCache: null,
    allowedPaths: ["src"],
    prohibitedPaths: [".git", "hidden-validator.mjs"],
    limits: {
      wallClockMs: 20_000,
      commandTimeoutMs: 5_000,
      memoryBytes: 128 * 1024 * 1024,
      diskBytes: 16 * 1024 * 1024,
      pids: 32,
      cpus: 1,
      maxCommands: 8,
      maxTurns: 4,
    },
    provenance: {
      sourceRepository: "https://example.invalid/repository",
      sourceCommit: "0".repeat(40),
      licenseSpdx: "MIT",
      acquisitionDigest: "1".repeat(64),
      validatorDigest: sha256(validatorSource),
      familyId: "2".repeat(64),
      split: "dev",
    },
  };
  return { root, task };
}

function editStep(script: string): DeterministicHarnessStep {
  return {
    command: {
      argv: [process.execPath, "-e", script],
      cwd: ".",
      env: {},
      timeoutMs: 2_000,
    },
    cumulativeModelTokens: 100,
  };
}

describe("AgentWorkflowRunner deterministic conformance", () => {
  test("runs edit, checkpoints, visible checks, and hidden scoring end to end", async () => {
    const { task } = await fixture();
    const driver = new FakeSandboxDriver();
    const runner = new AgentWorkflowRunner(driver);
    const result = await runner.run({
      task,
      prompt: task.taskRequest,
      harness: new DeterministicWritableHarnessAdapter([
        editStep(
          "require('fs').writeFileSync('src/value.js', \"export default 'right';\\n\")",
        ),
      ]),
    });
    expect(result.status).toBe("passed");
    expect(result.hiddenValidatorPassed).toBe(true);
    expect(result.visibleValidatorPassed).toBe(true);
    expect(result.tokensToFirstPassingCheckpoint).toBe(100);
    expect(result.finalPatch).toContain("right");
    expect(result.transcript.entries.length).toBeGreaterThan(1);
    expect(
      result.commandLog.some(({ phase }) => phase === "hidden-validator"),
    ).toBe(true);
  });

  test("preserves nonzero harness failures and a failed-final checkpoint", async () => {
    const { task } = await fixture();
    const driver = new FakeSandboxDriver();
    const result = await new AgentWorkflowRunner(driver, {
      retainFailedWorkspaces: true,
    }).run({
      task,
      prompt: task.taskRequest,
      harness: new DeterministicWritableHarnessAdapter([
        editStep("process.stderr.write('failed edit'); process.exit(9)"),
      ]),
    });
    expect(result.status).toBe("harness-failed");
    expect(result.failure?.message).toContain("failed edit");
    expect(result.retainedWorkspace).toBeTruthy();
    expect(result.commandLog.some(({ exitCode }) => exitCode === 9)).toBe(true);
    await driver.cleanup();
  });

  test("denies egress and writes outside the workspace", async () => {
    const first = await fixture();
    const egress = await new AgentWorkflowRunner(new FakeSandboxDriver()).run({
      task: first.task,
      prompt: first.task.taskRequest,
      harness: new DeterministicWritableHarnessAdapter([
        {
          command: {
            argv: ["curl", "https://example.com"],
            cwd: ".",
            env: {},
            timeoutMs: 2_000,
          },
          cumulativeModelTokens: null,
        },
      ]),
    });
    expect(egress.status).toBe("harness-failed");
    expect(egress.failure?.message).toContain("network denied");

    const second = await fixture();
    const escape = await new AgentWorkflowRunner(new FakeSandboxDriver()).run({
      task: second.task,
      prompt: second.task.taskRequest,
      harness: new DeterministicWritableHarnessAdapter([
        editStep("require('fs').writeFileSync('../escape.txt','escaped')"),
      ]),
    });
    expect(escape.status).toBe("policy-violation");
    expect(escape.failure?.message).toContain("outside workspace");
  });

  test("leaves the immutable source snapshot byte-identical across resets", async () => {
    const { task } = await fixture();
    const before = await digestTree(task.snapshotDirectory);
    const harness = new DeterministicWritableHarnessAdapter([
      editStep(
        "require('fs').writeFileSync('src/value.js', \"export default 'right';\\n\")",
      ),
    ]);
    const runner = new AgentWorkflowRunner(new FakeSandboxDriver());
    await runner.run({ task, prompt: task.taskRequest, harness });
    await runner.run({ task, prompt: task.taskRequest, harness });
    expect(await digestTree(task.snapshotDirectory)).toBe(before);
  });
});
