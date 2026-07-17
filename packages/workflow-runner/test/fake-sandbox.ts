import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  CommandEvidence,
  RepositoryTaskSpec,
  SandboxControl,
  WorkflowCommand,
} from "../src/schemas.js";
import type {
  SandboxDriver,
  SandboxExecution,
  TrialSandbox,
} from "../src/sandbox.js";
import { runProcess } from "../src/process.js";
import { copyTreeExact, sha256 } from "../src/tree.js";

const CONTROL: SandboxControl = {
  implementation: "docker-oci-v1",
  dockerVersion: "fake-1",
  imageDigest: `sha256:${"0".repeat(64)}`,
  networkMode: "none",
  proxyPolicyDigest: null,
  nonRootUid: 10001,
  readOnlyRoot: true,
  noNewPrivileges: true,
  capabilitiesDropped: true,
  capabilityAllowlist: [
    "CHOWN",
    "DAC_OVERRIDE",
    "FOWNER",
    "KILL",
    "SETGID",
    "SETUID",
  ],
  seccompProfileDigest: "0".repeat(64),
  auditedStatePaths: ["/home/agent", "/tmp"],
  workspaceTmpfsBytes: 16 * 1024 * 1024,
  memoryBytes: 128 * 1024 * 1024,
  pids: 32,
  cpus: 1,
  processTraceVerified: true,
};

export class FakeSandboxDriver implements SandboxDriver {
  readonly retained: string[] = [];

  async probe(): Promise<SandboxControl> {
    return CONTROL;
  }

  async create(
    task: RepositoryTaskSpec,
    options: { role: "agent" | "scorer" | "harness-probe" } = {
      role: "agent",
    },
  ): Promise<TrialSandbox> {
    const root = await mkdtemp(join(tmpdir(), "workflow-fake-sandbox-"));
    const workspace = join(root, "workspace");
    const checkpoints = join(root, "checkpoints");
    await Promise.all([
      copyTreeExact(task.snapshotDirectory, workspace),
      mkdir(checkpoints, { recursive: true }),
    ]);
    let sequence = 0;
    let disposed = false;
    const execute = async (
      phase: CommandEvidence["phase"],
      command: WorkflowCommand,
    ): Promise<SandboxExecution> => {
      const startedAt = new Date().toISOString();
      const argv = command.argv.map((argument) =>
        argument === "/scorer/hidden-validator"
          ? task.hiddenValidatorSourcePath
          : argument,
      );
      let result;
      if (argv[0] === "curl" || argv[0] === "wget") {
        result = {
          exitCode: 7,
          signal: null,
          stdout: "",
          stderr: "network denied by fake conformance sandbox",
          timedOut: false,
          outputOverflow: false,
          stdoutDigest: sha256(""),
          stderrDigest: sha256("network denied by fake conformance sandbox"),
          durationMs: 0,
        } as const;
      } else {
        result = await runProcess(argv[0] ?? "", argv.slice(1), {
          cwd: join(workspace, command.cwd === "." ? "" : command.cwd),
          env: command.env,
          timeoutMs: command.timeoutMs,
          maxOutputBytes: 64 * 1024,
        });
      }
      const outsideEntries = (await readdir(root)).filter(
        (entry) => !["workspace", "checkpoints"].includes(entry),
      );
      const policyViolation = outsideEntries.length > 0;
      const stderr = policyViolation
        ? `${result.stderr}\npolicy violation: write outside workspace`
        : result.stderr;
      const completedAt = new Date().toISOString();
      const evidence: CommandEvidence = {
        sequence: sequence++,
        phase,
        argv,
        cwd: command.cwd,
        startedAt,
        completedAt,
        durationMs: result.durationMs,
        exitCode: policyViolation ? 126 : result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        outputOverflow: result.outputOverflow,
        stdout: result.stdout,
        stderr,
        stdoutDigest: result.stdoutDigest,
        stderrDigest: sha256(stderr),
        processTraceDigest: sha256(
          JSON.stringify({ argv, role: options.role }),
        ),
      };
      return {
        evidence,
        ok:
          !policyViolation &&
          !result.timedOut &&
          !result.outputOverflow &&
          result.exitCode === 0,
      };
    };
    const checkpoint = async (checkpointId: string) => {
      const destination = join(checkpoints, checkpointId);
      await copyTreeExact(workspace, destination);
      return {
        workspaceDirectory: destination,
        harnessStateDigests: {
          home: sha256("[]"),
          tmp: sha256("[]"),
        },
        harnessStateChanges: { home: [], tmp: [] },
      };
    };
    const activateAgentPolicy = async (): Promise<void> => {};
    const dispose = async (retain: boolean): Promise<string | null> => {
      if (retain) {
        if (!this.retained.includes(root)) {
          this.retained.push(root);
        }
        disposed = true;
        return root;
      }
      if (!disposed) {
        disposed = true;
        await rm(root, { recursive: true, force: true });
      }
      return null;
    };
    return {
      control: CONTROL,
      execute,
      activateAgentPolicy,
      checkpoint,
      dispose,
    };
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.retained.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  }
}

export async function writeFixtureFile(
  path: string,
  content: string,
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
