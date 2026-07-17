import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  CommandEvidence,
  RepositoryTaskSpec,
  SandboxControl,
  WorkflowCommand,
} from "./schemas.js";
import { runProcess, runProcessToFile, type ProcessResult } from "./process.js";
import {
  assertSnapshotDigest,
  changedPaths,
  digestCorpusCompatibleTree,
  digestTree,
  sha256,
  unauthorizedChanges,
  validateFinalTreeSafety,
  validateWriteRoots,
} from "./tree.js";

const TRIAL_UID = 10001;
const TRIAL_GID = 10001;

export interface SandboxExecution {
  evidence: CommandEvidence;
  ok: boolean;
}

export interface SandboxCheckpoint {
  workspaceDirectory: string;
  harnessStateDigests: {
    home: string;
    tmp: string;
  };
  harnessStateChanges: {
    home: string[];
    tmp: string[];
  };
}

export interface TrialSandbox {
  readonly control: SandboxControl;
  execute(
    phase: CommandEvidence["phase"],
    command: WorkflowCommand,
  ): Promise<SandboxExecution>;
  activateAgentPolicy(): Promise<void>;
  checkpoint(checkpointId: string): Promise<SandboxCheckpoint>;
  dispose(retain: boolean): Promise<string | null>;
}

export interface SandboxDriver {
  probe(
    task: RepositoryTaskSpec,
    options?: { role: "agent" | "scorer" | "harness-probe" },
  ): Promise<SandboxControl>;
  create(
    task: RepositoryTaskSpec,
    options?: { role: "agent" | "scorer" | "harness-probe" },
  ): Promise<TrialSandbox>;
}

export interface DockerSandboxConfig {
  dockerBin?: string;
  runnerImage: string;
  expectedImageDigest: string;
  seccompProfile: string;
  seccompProfileDigest: string;
  network:
    | { mode: "none" }
    | {
        mode: "allowlist-proxy";
        trialNetwork: string;
        proxyContainer: string;
        proxyImageDigest: string;
        proxyUrl: string;
        proxyCaPath: string;
        proxyCaDigest: string;
        proxyPolicyPath: string;
        proxyPolicyDigest: string;
      };
  processRunner?: typeof runProcess;
  auditedStateAllowlist: {
    home: readonly string[];
    tmp: readonly string[];
  };
  stagingRoot?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function writablePathsScript(paths: readonly string[]): string {
  return paths
    .map(
      (path) =>
        `target=${shellQuote(`/workspace/${path}`)}; if [ ! -e "$target" ] && [ ! -L "$target" ]; then mkdir -p "$target"; fi; chown -R ${TRIAL_UID}:${TRIAL_GID} "$target" && chmod -R u+rwX "$target"`,
    )
    .join(" && ");
}

function initScript(
  task: RepositoryTaskSpec,
  writablePaths: readonly string[],
): string {
  const writable = writablePathsScript(writablePaths);
  return [
    "set -eu",
    "cp -a /snapshot/. /workspace/",
    "chown -R 0:0 /workspace",
    "chmod -R a-w /workspace",
    `chown -R ${TRIAL_UID}:${TRIAL_GID} /home/agent`,
    writable,
  ].join(" && ");
}

async function docker(
  runner: typeof runProcess,
  bin: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  const result = await runner(bin, args, { timeoutMs });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `Docker command failed: ${bin} ${args.join(" ")}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function imageDigestFromInspect(stdout: string): string {
  const digest = stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Docker image inspect returned invalid digest: ${digest}`);
  }
  return digest;
}

export class DockerSandboxDriver implements SandboxDriver {
  readonly #bin: string;
  readonly #runner: typeof runProcess;

  constructor(readonly config: DockerSandboxConfig) {
    this.#bin = config.dockerBin ?? "docker";
    this.#runner = config.processRunner ?? runProcess;
  }

  async probe(
    task: RepositoryTaskSpec,
    options: { role: "agent" | "scorer" | "harness-probe" } = {
      role: "agent",
    },
  ): Promise<SandboxControl> {
    await assertSnapshotDigest(task.snapshotDirectory, task.snapshotDigest);
    await validateWriteRoots(
      task.snapshotDirectory,
      task.allowedPaths,
      task.prohibitedPaths,
    );
    const validatorSourceDigest = sha256(
      await readFile(resolve(task.hiddenValidatorSourcePath)),
    );
    if (validatorSourceDigest !== task.hiddenValidatorSourceDigest) {
      throw new Error(
        `Hidden validator source digest mismatch: expected ${task.hiddenValidatorSourceDigest}, received ${validatorSourceDigest}`,
      );
    }
    if (task.offlineDependencyCache) {
      const cacheDigest = await digestCorpusCompatibleTree(
        task.offlineDependencyCache.directory,
      );
      if (cacheDigest !== task.offlineDependencyCache.digest) {
        throw new Error(
          `Offline dependency cache digest mismatch: expected ${task.offlineDependencyCache.digest}, received ${cacheDigest}`,
        );
      }
    }
    const seccompDigest = sha256(await readFile(this.config.seccompProfile));
    if (seccompDigest !== this.config.seccompProfileDigest) {
      throw new Error(
        `Seccomp profile digest mismatch: expected ${this.config.seccompProfileDigest}, received ${seccompDigest}`,
      );
    }
    if (
      options.role === "agent" &&
      this.config.network.mode === "allowlist-proxy"
    ) {
      const policyDigest = sha256(
        await readFile(this.config.network.proxyPolicyPath),
      );
      if (policyDigest !== this.config.network.proxyPolicyDigest) {
        throw new Error(
          `Proxy policy digest mismatch: expected ${this.config.network.proxyPolicyDigest}, received ${policyDigest}`,
        );
      }
      const caDigest = sha256(await readFile(this.config.network.proxyCaPath));
      if (caDigest !== this.config.network.proxyCaDigest) {
        throw new Error(
          `Proxy CA digest mismatch: expected ${this.config.network.proxyCaDigest}, received ${caDigest}`,
        );
      }
      const network = await docker(this.#runner, this.#bin, [
        "network",
        "inspect",
        "--format",
        "{{.Internal}}",
        this.config.network.trialNetwork,
      ]);
      if (network.stdout.trim() !== "true") {
        throw new Error("Trial network is not Docker-internal; fail closed.");
      }
      const proxyPolicy = await docker(this.#runner, this.#bin, [
        "inspect",
        "--format",
        '{{ index .Config.Labels "org.sema-evals.proxy-policy-digest" }}',
        this.config.network.proxyContainer,
      ]);
      if (proxyPolicy.stdout.trim() !== policyDigest) {
        throw new Error(
          "Allowlist proxy container policy label does not match the frozen policy.",
        );
      }
      const proxyImage = await docker(this.#runner, this.#bin, [
        "inspect",
        "--format",
        "{{.Image}}",
        this.config.network.proxyContainer,
      ]);
      if (proxyImage.stdout.trim() !== this.config.network.proxyImageDigest) {
        throw new Error(
          "Allowlist proxy image digest does not match the frozen image.",
        );
      }
      const networkContainers = await docker(this.#runner, this.#bin, [
        "network",
        "inspect",
        "--format",
        "{{json .Containers}}",
        this.config.network.trialNetwork,
      ]);
      const attached = JSON.parse(networkContainers.stdout) as Record<
        string,
        { Name?: string }
      >;
      const attachedNames = Object.values(attached)
        .map(({ Name }) => Name)
        .filter((name): name is string => name !== undefined);
      if (
        attachedNames.length !== 1 ||
        attachedNames[0] !== this.config.network.proxyContainer
      ) {
        throw new Error(
          `Internal trial network must contain only the pinned proxy before trial creation; found ${attachedNames.join(",")}`,
        );
      }
      const proxyNetworks = await docker(this.#runner, this.#bin, [
        "inspect",
        "--format",
        "{{json .NetworkSettings.Networks}}",
        this.config.network.proxyContainer,
      ]);
      if (!proxyNetworks.stdout.includes(this.config.network.trialNetwork)) {
        throw new Error(
          "Allowlist proxy is not attached to the internal trial network.",
        );
      }
    }
    const version = await docker(this.#runner, this.#bin, [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    const inspect = await docker(this.#runner, this.#bin, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      this.config.runnerImage,
    ]);
    const imageDigest = imageDigestFromInspect(inspect.stdout);
    if (imageDigest !== this.config.expectedImageDigest) {
      throw new Error(
        `Runner image digest mismatch: expected ${this.config.expectedImageDigest}, received ${imageDigest}`,
      );
    }

    const traceProbe = await this.#runner(
      this.#bin,
      [
        "run",
        "--rm",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "SETUID",
        "--security-opt",
        "no-new-privileges:true",
        "--security-opt",
        `seccomp=${this.config.seccompProfile}`,
        "--network",
        "none",
        "--tmpfs",
        "/run/sema-traces:rw,nosuid,nodev,size=16777216,uid=0,gid=0,mode=0700",
        "--entrypoint",
        "sh",
        this.config.runnerImage,
        "-lc",
        `node_major=$(node -p 'process.versions.node.split(".")[0]'); test "$node_major" -ge 22 && command -v git >/dev/null && command -v setpriv >/dev/null && command -v strace >/dev/null && mkdir -p /run/sema-traces/probe && chmod 0700 /run/sema-traces/probe && strace -ff -e trace=process -o /run/sema-traces/probe/trace -- setpriv --reuid=${TRIAL_UID} --regid=${TRIAL_GID} --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs sh -lc 'true' && grep -R execve /run/sema-traces/probe >/dev/null`,
      ],
      { timeoutMs: 30_000 },
    );
    if (traceProbe.timedOut || traceProbe.exitCode !== 0) {
      throw new Error(
        `Runner image control probe failed closed: ${traceProbe.stderr || traceProbe.stdout}`,
      );
    }
    return {
      implementation: "docker-oci-v1",
      dockerVersion: version.stdout.trim(),
      imageDigest,
      networkMode: options.role === "agent" ? this.config.network.mode : "none",
      proxyPolicyDigest:
        options.role === "agent" &&
        this.config.network.mode === "allowlist-proxy"
          ? this.config.network.proxyPolicyDigest
          : null,
      nonRootUid: TRIAL_UID,
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
      seccompProfileDigest: seccompDigest,
      auditedStatePaths: ["/home/agent", "/tmp"],
      workspaceTmpfsBytes: task.limits.diskBytes,
      memoryBytes: task.limits.memoryBytes,
      pids: task.limits.pids,
      cpus: task.limits.cpus,
      processTraceVerified: true,
    };
  }

  async create(
    task: RepositoryTaskSpec,
    options: { role: "agent" | "scorer" | "harness-probe" } = {
      role: "agent",
    },
  ): Promise<TrialSandbox> {
    const control = await this.probe(task, options);
    const stagingParent = resolve(
      this.config.stagingRoot ?? ".cache/sema-evals/workflow-runner",
    );
    await mkdir(stagingParent, { recursive: true });
    const stagingRoot = await mkdtemp(
      join(stagingParent, "sema-workflow-trial-"),
    );
    const checkpointsRoot = join(stagingRoot, "checkpoints");
    const tracesRoot = join(stagingRoot, "traces");
    await Promise.all([
      mkdir(checkpointsRoot, { recursive: true }),
      mkdir(tracesRoot, { recursive: true }),
    ]);
    const containerName = `sema-evals-${randomUUID()}`;
    const networkArgs =
      options.role !== "agent" || this.config.network.mode === "none"
        ? ["--network", "none"]
        : ["--network", this.config.network.trialNetwork];
    const validatorContainerPath =
      task.hiddenValidator.argv.find((argument) =>
        argument.startsWith("/scorer/"),
      ) ?? "/scorer/hidden-validator";
    const scorerMount =
      options.role === "scorer"
        ? [
            "--mount",
            `type=bind,src=${resolve(task.hiddenValidatorSourcePath)},dst=${validatorContainerPath},readonly`,
          ]
        : [];
    const proxyCaMount =
      options.role === "agent" && this.config.network.mode === "allowlist-proxy"
        ? [
            "--mount",
            `type=bind,src=${resolve(this.config.network.proxyCaPath)},dst=/run/sema-proxy/ca.pem,readonly`,
          ]
        : [];
    const dependencyCacheMount =
      options.role === "agent" && task.offlineDependencyCache
        ? [
            "--mount",
            `type=bind,src=${resolve(task.offlineDependencyCache.directory)},dst=/workflow-cache-sealed,readonly`,
          ]
        : [];
    const dependencyCacheTmpfs =
      options.role === "agent" && task.offlineDependencyCache
        ? [
            "--tmpfs",
            `/workflow-cache:rw,nosuid,nodev,size=${Math.min(
              task.limits.diskBytes,
              512 * 1024 * 1024,
            )}`,
          ]
        : [];
    await docker(this.#runner, this.#bin, [
      "create",
      "--name",
      containerName,
      "--hostname",
      "sema-trial",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--cap-add",
      "KILL",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "SETUID",
      "--security-opt",
      "no-new-privileges:true",
      "--security-opt",
      `seccomp=${this.config.seccompProfile}`,
      "--memory",
      String(task.limits.memoryBytes),
      "--memory-swap",
      String(task.limits.memoryBytes),
      "--pids-limit",
      String(task.limits.pids),
      "--cpus",
      String(task.limits.cpus),
      "--tmpfs",
      `/workspace:rw,nosuid,nodev,size=${task.limits.diskBytes}`,
      "--tmpfs",
      `/tmp:rw,nosuid,nodev,size=67108864,uid=${TRIAL_UID},gid=${TRIAL_GID}`,
      "--tmpfs",
      `/home/agent:rw,nosuid,nodev,size=16777216,uid=${TRIAL_UID},gid=${TRIAL_GID},mode=0700`,
      "--tmpfs",
      "/run/sema-traces:rw,nosuid,nodev,size=67108864,uid=0,gid=0,mode=0700",
      "--mount",
      `type=bind,src=${resolve(task.snapshotDirectory)},dst=/snapshot,readonly`,
      ...scorerMount,
      ...proxyCaMount,
      ...dependencyCacheMount,
      ...dependencyCacheTmpfs,
      ...networkArgs,
      "--entrypoint",
      "sh",
      this.config.runnerImage,
      "-lc",
      "exec sleep infinity",
    ]);
    try {
      await docker(this.#runner, this.#bin, ["start", containerName]);
      await docker(this.#runner, this.#bin, [
        "exec",
        "--user",
        "0:0",
        containerName,
        "sh",
        "-lc",
        options.role === "scorer"
          ? `${initScript(task, task.allowedPaths)} && chown -R ${TRIAL_UID}:${TRIAL_GID} /workspace && chmod -R u+rwX /workspace`
          : [
              initScript(
                task,
                options.role === "agent" && task.offlineDependencyCache
                  ? [
                      ...new Set([
                        ...task.allowedPaths,
                        ...task.offlineDependencyCache.setupWritablePaths,
                      ]),
                    ]
                  : task.allowedPaths,
              ),
              ...(options.role === "agent" && task.offlineDependencyCache
                ? [
                    `cp -a /workflow-cache-sealed/. /workflow-cache/ && chown -R ${TRIAL_UID}:${TRIAL_GID} /workflow-cache`,
                  ]
                : []),
            ].join(" && "),
      ]);
    } catch (error) {
      await this.#runner(this.#bin, ["rm", "-f", containerName], {
        timeoutMs: 30_000,
      });
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }

    const copyDirectoryOut = async (
      source: string,
      destination: string,
      maxBytes: number,
    ): Promise<void> => {
      await mkdir(destination, { recursive: true });
      const archivePath = join(stagingRoot, `extract-${randomUUID()}.tar`);
      const archive = await runProcessToFile(
        this.#bin,
        [
          "exec",
          "--user",
          "0:0",
          containerName,
          "tar",
          "-C",
          source,
          "-cf",
          "-",
          ".",
        ],
        archivePath,
        {
          timeoutMs: 30_000,
          maxOutputBytes: maxBytes + 16 * 1024 * 1024,
        },
      );
      if (
        archive.timedOut ||
        archive.outputOverflow ||
        archive.exitCode !== 0 ||
        archive.outputBytes === 0
      ) {
        throw new Error(
          `Sandbox extraction failed closed for ${source}: ${
            archive.stderr || "empty/overflow archive"
          }`,
        );
      }
      try {
        await docker(
          runProcess,
          "tar",
          ["-xf", archivePath, "-C", destination],
          30_000,
        );
      } finally {
        await rm(archivePath, { force: true });
      }
    };

    const initialStateRoot = join(stagingRoot, "state-initial");
    await Promise.all([
      copyDirectoryOut(
        "/home/agent",
        join(initialStateRoot, "home"),
        16 * 1024 * 1024,
      ),
      copyDirectoryOut("/tmp", join(initialStateRoot, "tmp"), 64 * 1024 * 1024),
    ]);

    let sequence = 0;
    let disposed = false;
    let agentPolicyActive = options.role !== "agent";
    const unexpectedProcesses = async (): Promise<string[]> => {
      const processes = await docker(this.#runner, this.#bin, [
        "top",
        containerName,
        "-eo",
        "pid,user,args",
      ]);
      const rows = processes.stdout
        .trim()
        .split(/\r?\n/)
        .slice(1)
        .filter((line) => line.trim());
      return rows.filter((row) => !row.includes("sleep infinity"));
    };
    const terminateTrialProcesses = async (): Promise<void> => {
      const cleanup = await this.#runner(
        this.#bin,
        [
          "exec",
          "--user",
          "0:0",
          containerName,
          "sh",
          "-lc",
          `pkill -KILL -u ${TRIAL_UID} || true`,
        ],
        { timeoutMs: 10_000 },
      );
      if (cleanup.timedOut || cleanup.exitCode !== 0) {
        throw new Error(
          `Failed to terminate timed-out trial processes: ${cleanup.stderr}`,
        );
      }
    };

    const execute = async (
      phase: CommandEvidence["phase"],
      command: WorkflowCommand,
    ): Promise<SandboxExecution> => {
      if (disposed) {
        throw new Error("Trial sandbox is already disposed.");
      }
      const currentSequence = sequence++;
      const traceDirectoryInContainer = `/run/sema-traces/${currentSequence}`;
      const tracePrefix = `${traceDirectoryInContainer}/trace`;
      await docker(this.#runner, this.#bin, [
        "exec",
        "--user",
        "0:0",
        containerName,
        "sh",
        "-lc",
        `mkdir -p ${shellQuote(traceDirectoryInContainer)} && chmod 0700 ${shellQuote(traceDirectoryInContainer)}`,
      ]);
      const startedAt = new Date().toISOString();
      const timeoutSeconds = Math.max(
        1,
        Math.ceil(
          Math.min(command.timeoutMs, task.limits.commandTimeoutMs) / 1000,
        ),
      );
      const result = await this.#runner(
        this.#bin,
        [
          "exec",
          "--user",
          "0:0",
          "--workdir",
          `/workspace/${command.cwd === "." ? "" : command.cwd}`,
          "--env",
          "HOME=/home/agent",
          "--env",
          "XDG_CONFIG_HOME=/home/agent/.config",
          ...(options.role === "agent" &&
          this.config.network.mode === "allowlist-proxy"
            ? [
                "--env",
                `HTTPS_PROXY=${this.config.network.proxyUrl}`,
                "--env",
                `HTTP_PROXY=${this.config.network.proxyUrl}`,
                "--env",
                `ALL_PROXY=${this.config.network.proxyUrl}`,
                "--env",
                "NO_PROXY=",
                "--env",
                "SSL_CERT_FILE=/run/sema-proxy/ca.pem",
              ]
            : []),
          ...Object.entries(command.env).flatMap(([key, value]) => [
            "--env",
            `${key}=${value}`,
          ]),
          containerName,
          "timeout",
          "--signal=TERM",
          "--kill-after=1",
          String(timeoutSeconds),
          "strace",
          "-ff",
          "-e",
          "trace=process",
          "-o",
          tracePrefix,
          "--",
          "setpriv",
          `--reuid=${TRIAL_UID}`,
          `--regid=${TRIAL_GID}`,
          "--clear-groups",
          "--inh-caps=-all",
          "--ambient-caps=-all",
          "--bounding-set=-all",
          "--no-new-privs",
          ...command.argv,
        ],
        {
          timeoutMs:
            Math.min(command.timeoutMs, task.limits.commandTimeoutMs) + 5_000,
        },
      );
      const completedAt = new Date().toISOString();
      const traceDirectory = join(tracesRoot, String(currentSequence));
      await mkdir(traceDirectory, { recursive: true });
      const traceArchivePath = join(traceDirectory, "trace.tar");
      const traceArchive = await runProcessToFile(
        this.#bin,
        [
          "exec",
          "--user",
          "0:0",
          containerName,
          "tar",
          "-C",
          traceDirectoryInContainer,
          "-cf",
          "-",
          ".",
        ],
        traceArchivePath,
        {
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024 * 1024,
        },
      );
      if (
        traceArchive.timedOut ||
        traceArchive.outputOverflow ||
        traceArchive.exitCode !== 0 ||
        traceArchive.outputBytes === 0
      ) {
        throw new Error(
          `Process trace extraction failed closed: ${traceArchive.stderr || "empty/overflow trace archive"}`,
        );
      }
      const processTraceDigest = traceArchive.outputDigest;
      const timedOut =
        result.timedOut || result.exitCode === 124 || result.exitCode === 137;
      if (timedOut || result.outputOverflow) {
        await terminateTrialProcesses();
      }
      const backgroundProcesses = await unexpectedProcesses();
      if (backgroundProcesses.length > 0) {
        await terminateTrialProcesses();
        const remainingProcesses = await unexpectedProcesses();
        if (remainingProcesses.length > 0) {
          throw new Error(
            `Failed to clean trial background processes: ${remainingProcesses.join(" | ")}`,
          );
        }
        if (!timedOut && result.exitCode === 0) {
          throw new Error(
            `Trial left background processes running: ${backgroundProcesses.join(" | ")}`,
          );
        }
      }
      const evidence: CommandEvidence = {
        sequence: currentSequence,
        phase,
        argv: [...command.argv],
        cwd: command.cwd,
        startedAt,
        completedAt,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut,
        outputOverflow: result.outputOverflow,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutDigest: result.stdoutDigest,
        stderrDigest: result.stderrDigest,
        processTraceDigest,
      };
      return {
        evidence,
        ok: !result.timedOut && result.exitCode === 0,
      };
    };

    const checkpoint = async (
      checkpointId: string,
    ): Promise<SandboxCheckpoint> => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(checkpointId)) {
        throw new Error(`Unsafe checkpoint id: ${checkpointId}`);
      }
      const destination = join(checkpointsRoot, checkpointId);
      const stateDestination = join(stagingRoot, "state", checkpointId);
      await mkdir(destination, { recursive: true });
      await mkdir(stateDestination, { recursive: true });
      const backgroundProcesses = await unexpectedProcesses();
      if (backgroundProcesses.length > 0) {
        await terminateTrialProcesses();
        throw new Error(
          `Trial left background processes running before checkpoint: ${backgroundProcesses.join(" | ")}`,
        );
      }
      await Promise.all([
        copyDirectoryOut("/workspace", destination, task.limits.diskBytes),
        copyDirectoryOut(
          "/home/agent",
          join(stateDestination, "home"),
          16 * 1024 * 1024,
        ),
        copyDirectoryOut(
          "/tmp",
          join(stateDestination, "tmp"),
          64 * 1024 * 1024,
        ),
      ]);
      await validateFinalTreeSafety(destination, task.allowedPaths);
      const homeChanges = await changedPaths(
        join(initialStateRoot, "home"),
        join(stateDestination, "home"),
      );
      const tmpChanges = await changedPaths(
        join(initialStateRoot, "tmp"),
        join(stateDestination, "tmp"),
      );
      const unauthorizedHome = unauthorizedChanges(
        homeChanges,
        this.config.auditedStateAllowlist.home,
      );
      const unauthorizedTmp = unauthorizedChanges(
        tmpChanges,
        this.config.auditedStateAllowlist.tmp,
      );
      if (unauthorizedHome.length > 0 || unauthorizedTmp.length > 0) {
        throw new Error(
          `Harness state policy violation: home=[${unauthorizedHome.join(",")}], tmp=[${unauthorizedTmp.join(",")}]`,
        );
      }
      return {
        workspaceDirectory: destination,
        harnessStateDigests: {
          home: await digestTree(join(stateDestination, "home")),
          tmp: await digestTree(join(stateDestination, "tmp")),
        },
        harnessStateChanges: {
          home: homeChanges,
          tmp: tmpChanges,
        },
      };
    };

    const activateAgentPolicy = async (): Promise<void> => {
      if (options.role !== "agent" || agentPolicyActive) {
        return;
      }
      const backgroundProcesses = await unexpectedProcesses();
      if (backgroundProcesses.length > 0) {
        await terminateTrialProcesses();
        throw new Error(
          `Trial left background processes running before policy activation: ${backgroundProcesses.join(" | ")}`,
        );
      }
      await docker(this.#runner, this.#bin, [
        "exec",
        "--user",
        "0:0",
        containerName,
        "sh",
        "-lc",
        [
          "set -eu",
          "chown -R 0:0 /workspace",
          "chmod -R a-w /workspace",
          ...(task.offlineDependencyCache
            ? ["chown -R 0:0 /workflow-cache", "chmod -R a-w /workflow-cache"]
            : []),
          writablePathsScript(task.allowedPaths),
        ].join(" && "),
      ]);
      agentPolicyActive = true;
    };

    const dispose = async (retain: boolean): Promise<string | null> => {
      if (!disposed) {
        disposed = true;
        await this.#runner(this.#bin, ["rm", "-f", containerName], {
          timeoutMs: 30_000,
        });
      }
      if (retain) {
        return stagingRoot;
      }
      await runProcess("chmod", ["-R", "u+w", stagingRoot], {
        timeoutMs: 10_000,
      });
      await rm(stagingRoot, { recursive: true, force: true });
      return null;
    };

    return {
      control,
      execute,
      activateAgentPolicy,
      checkpoint,
      dispose,
    };
  }
}
