import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import { describe, expect, test } from "vitest";

import { runProcess } from "../src/process.js";
import { DockerSandboxDriver } from "../src/sandbox.js";
import type { RepositoryTaskSpec } from "../src/schemas.js";
import { digestTree, sha256 } from "../src/tree.js";

const enabled = process.env["WORKFLOW_RUNNER_DOCKER_TEST"] === "1";
const suite = enabled ? describe : describe.skip;

async function dockerTask(): Promise<RepositoryTaskSpec> {
  const cacheRoot = resolve(".cache/sema-evals/workflow-runner-tests");
  await mkdir(cacheRoot, { recursive: true });
  const root = await mkdtemp(join(cacheRoot, "workflow-docker-task-"));
  const snapshot = join(root, "snapshot");
  const validator = join(root, "hidden-validator.mjs");
  await mkdir(join(snapshot, "src"), { recursive: true });
  await writeFile(join(snapshot, "src", "value.js"), "export default 1;\n");
  const validatorSource =
    "import {readFileSync} from 'node:fs';process.exit(readFileSync('src/value.js','utf8').includes('2')?0:4);";
  await writeFile(validator, validatorSource);
  return {
    schemaVersion: "workflow-repository-task-v1",
    taskId: "docker-controls",
    snapshotDirectory: snapshot,
    snapshotDigest: await digestTree(snapshot),
    taskRequest: "Change the exported value.",
    setupCommand: null,
    visibleChecks: [
      {
        argv: ["node", "--check", "src/value.js"],
        cwd: ".",
        env: {},
        timeoutMs: 5_000,
      },
    ],
    hiddenValidator: {
      argv: ["node", validator],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    },
    hiddenValidatorSourcePath: validator,
    hiddenValidatorSourceDigest: sha256(validatorSource),
    offlineDependencyCache: null,
    allowedPaths: ["src"],
    prohibitedPaths: [".git"],
    limits: {
      wallClockMs: 30_000,
      commandTimeoutMs: 10_000,
      memoryBytes: 128 * 1024 * 1024,
      diskBytes: 1024 * 1024,
      pids: 32,
      cpus: 1,
      maxCommands: 8,
      maxTurns: 4,
    },
    provenance: {
      sourceRepository: "https://example.invalid/docker-controls",
      sourceCommit: "0".repeat(40),
      licenseSpdx: "MIT",
      acquisitionDigest: "1".repeat(64),
      validatorDigest: sha256(validatorSource),
      familyId: "2".repeat(64),
      split: "dev",
    },
  };
}

async function driver(): Promise<DockerSandboxDriver> {
  const image =
    process.env["WORKFLOW_RUNNER_IMAGE"] ??
    "sema-evals/workflow-runner-conformance:node22";
  const inspect = await runProcess(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { timeoutMs: 10_000 },
  );
  if (inspect.exitCode !== 0) {
    throw new Error(inspect.stderr);
  }
  const seccompProfile = resolve(
    "packages/workflow-runner/docker/seccomp-conformance.json",
  );
  return new DockerSandboxDriver({
    runnerImage: image,
    expectedImageDigest: inspect.stdout.trim(),
    seccompProfile,
    seccompProfileDigest: sha256(await readFile(seccompProfile)),
    network: { mode: "none" },
    auditedStateAllowlist: { home: [], tmp: [] },
  });
}

suite("Docker workflow-runner controls", () => {
  test("directly enforces identity, read-only root, network-none, tracing, and reset", async () => {
    const task = await dockerTask();
    const sandboxDriver = await driver();
    const control = await sandboxDriver.probe(task);
    expect(control.nonRootUid).toBe(10001);
    expect(control.processTraceVerified).toBe(true);
    const sandbox = await sandboxDriver.create(task);
    const identity = await sandbox.execute("harness", {
      argv: ["id", "-u"],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(identity.evidence.stdout.trim()).toBe("10001");
    const rootWrite = await sandbox.execute("harness", {
      argv: ["sh", "-lc", "echo bad >/root/escape"],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(rootWrite.ok).toBe(false);
    const egress = await sandbox.execute("harness", {
      argv: [
        "node",
        "-e",
        "fetch('https://example.com').then(()=>process.exit(0)).catch(()=>process.exit(7))",
      ],
      cwd: ".",
      env: {},
      timeoutMs: 3_000,
    });
    expect(egress.ok).toBe(false);
    const edit = await sandbox.execute("harness", {
      argv: [
        "node",
        "-e",
        "require('fs').writeFileSync('src/value.js','export default 2;\\n')",
      ],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(edit.ok).toBe(true);
    expect(edit.evidence.processTraceDigest).toMatch(/^[a-f0-9]{64}$/);
    const checkpoint = await sandbox.checkpoint("edited");
    expect(await digestTree(checkpoint.workspaceDirectory)).not.toBe(
      task.snapshotDigest,
    );
    await sandbox.dispose(false);
    expect(await digestTree(task.snapshotDirectory)).toBe(task.snapshotDigest);
  }, 60_000);

  test("returns ENOSPC and rejects background daemons and post-run symlinks", async () => {
    const task = await dockerTask();
    const sandboxDriver = await driver();
    const diskSandbox = await sandboxDriver.create(task);
    const disk = await diskSandbox.execute("harness", {
      argv: [
        "node",
        "-e",
        "require('fs').writeFileSync('src/fill',Buffer.alloc(2*1024*1024))",
      ],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(disk.ok).toBe(false);
    expect(disk.evidence.stderr).toMatch(/ENOSPC|no space/i);
    await diskSandbox.dispose(false);

    const daemonSandbox = await sandboxDriver.create(task);
    const daemon = await daemonSandbox.execute("harness", {
      argv: [
        "node",
        "-e",
        "require('child_process').spawn('sleep',['30'],{detached:true,stdio:'ignore'}).unref()",
      ],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(daemon.ok).toBe(false);
    expect(daemon.evidence.timedOut).toBe(true);
    const afterDaemon = await daemonSandbox.execute("harness", {
      argv: ["id", "-u"],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(afterDaemon.ok).toBe(true);
    await daemonSandbox.dispose(false);

    const linkSandbox = await sandboxDriver.create(task);
    const link = await linkSandbox.execute("harness", {
      argv: ["ln", "-s", "/tmp", "src/escape-link"],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(link.ok).toBe(true);
    await expect(linkSandbox.checkpoint("unsafe")).rejects.toThrow(
      /symbolic link/,
    );
    await linkSandbox.dispose(false);
  }, 60_000);

  test("enforces process, memory, timeout, path, and context isolation controls", async () => {
    const task = await dockerTask();
    const sandboxDriver = await driver();
    const sandbox = await sandboxDriver.create(task);

    const contextIsolation = await sandbox.execute("harness", {
      argv: [
        "node",
        "-e",
        [
          "const fs=require('fs');",
          "const forbidden=[",
          "'/home/jiberish/projects/opensource/sema-evals/AGENTS.md',",
          "'/home/agent/.claude',",
          "'/home/agent/.codex/config.toml',",
          "'/scorer/hidden-validator'",
          "];",
          "process.exit(forbidden.some(path=>fs.existsSync(path))?5:0);",
        ].join(""),
      ],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(contextIsolation.ok).toBe(true);

    const prohibited = await sandbox.execute("harness", {
      argv: [
        "node",
        "-e",
        "require('fs').writeFileSync('README.md','forbidden')",
      ],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(prohibited.ok).toBe(false);

    const nonzero = await sandbox.execute("harness", {
      argv: ["sh", "-lc", "echo preserved >&2; exit 23"],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(nonzero.evidence.exitCode).toBe(23);
    expect(nonzero.evidence.stderr).toContain("preserved");

    const timeout = await sandbox.execute("harness", {
      argv: [
        "node",
        "-e",
        "require('child_process').spawn('sleep',['30']);setInterval(()=>{},1000)",
      ],
      cwd: ".",
      env: {},
      timeoutMs: 1_000,
    });
    expect(timeout.evidence.timedOut).toBe(true);
    const afterTimeout = await sandbox.execute("harness", {
      argv: ["id", "-u"],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(afterTimeout.ok).toBe(true);
    await sandbox.dispose(false);

    const pidTask = { ...task, limits: { ...task.limits, pids: 12 } };
    const pidSandbox = await sandboxDriver.create(pidTask);
    const pids = await pidSandbox.execute("harness", {
      argv: [
        "sh",
        "-lc",
        "set -e; for i in $(seq 1 40); do sleep 10 & done; wait",
      ],
      cwd: ".",
      env: {},
      timeoutMs: 2_000,
    });
    expect(pids.ok).toBe(false);
    await pidSandbox.dispose(false);

    const memoryTask = {
      ...task,
      limits: { ...task.limits, memoryBytes: 64 * 1024 * 1024 },
    };
    const memorySandbox = await sandboxDriver.create(memoryTask);
    const memory = await memorySandbox.execute("harness", {
      argv: [
        "node",
        "-e",
        "const values=[];for(let i=0;i<256;i++)values.push(Buffer.alloc(1024*1024,1));setTimeout(()=>{},10000)",
      ],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(memory.ok).toBe(false);
    await memorySandbox.dispose(false);
  }, 90_000);

  test("rejects hardlinks and special files and resets two independent trials", async () => {
    const task = await dockerTask();
    const sandboxDriver = await driver();

    const hardlinkSandbox = await sandboxDriver.create(task);
    const hardlink = await hardlinkSandbox.execute("harness", {
      argv: ["ln", "src/value.js", "src/hardlink.js"],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(hardlink.ok).toBe(true);
    await expect(hardlinkSandbox.checkpoint("hardlink")).rejects.toThrow(
      /hard-linked/,
    );
    await hardlinkSandbox.dispose(false);

    const fifoSandbox = await sandboxDriver.create(task);
    const fifo = await fifoSandbox.execute("harness", {
      argv: ["mkfifo", "src/special.pipe"],
      cwd: ".",
      env: {},
      timeoutMs: 5_000,
    });
    expect(fifo.ok).toBe(true);
    await expect(fifoSandbox.checkpoint("special")).rejects.toThrow(
      /special file/,
    );
    await fifoSandbox.dispose(false);

    for (let index = 0; index < 2; index += 1) {
      const trial = await sandboxDriver.create(task);
      const edit = await trial.execute("harness", {
        argv: [
          "node",
          "-e",
          `require('fs').writeFileSync('src/value.js','export default ${index + 2};\\n')`,
        ],
        cwd: ".",
        env: {},
        timeoutMs: 5_000,
      });
      expect(edit.ok).toBe(true);
      await trial.checkpoint(`trial-${index}`);
      await trial.dispose(false);
      expect(await digestTree(task.snapshotDirectory)).toBe(
        task.snapshotDigest,
      );
    }
  }, 90_000);
});
