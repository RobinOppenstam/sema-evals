import { fingerprint } from "@sema-evals/core";

import type {
  CheckpointEvidence,
  CommandEvidence,
  RepositoryTaskSpec,
  WorkflowRunnerResult,
  WorkflowRunnerStatus,
} from "./schemas.js";
import {
  repositoryTaskSpecSchema,
  workflowRunnerResultSchema,
  writableHarnessDescriptorSchema,
} from "./schemas.js";
import type { WritableHarnessAdapter } from "./harness.js";
import type {
  SandboxCheckpoint,
  SandboxDriver,
  TrialSandbox,
} from "./sandbox.js";
import { generateTreePatch } from "./patch.js";
import {
  digestTree,
  sha256,
  unauthorizedChanges,
  validateFinalTreeSafety,
} from "./tree.js";

const EMPTY_TRANSCRIPT = { entries: [] };

export interface AgentWorkflowRunnerOptions {
  retainFailedWorkspaces?: boolean;
}

interface ScoredCheckpoint {
  evidence: CheckpointEvidence;
  directory: string;
}

function failureStatus(
  message: string,
  fallback: WorkflowRunnerStatus,
): WorkflowRunnerStatus {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout")) {
    return "timeout";
  }
  if (
    normalized.includes("resource") ||
    normalized.includes("overflow") ||
    normalized.includes("enospc")
  ) {
    return "resource-violation";
  }
  if (
    normalized.includes("policy") ||
    normalized.includes("unauthorized") ||
    normalized.includes("symbolic link") ||
    normalized.includes("hard-linked") ||
    normalized.includes("special file")
  ) {
    return "policy-violation";
  }
  return fallback;
}

export class AgentWorkflowRunner {
  constructor(
    private readonly sandboxDriver: SandboxDriver,
    private readonly options: AgentWorkflowRunnerOptions = {},
  ) {}

  async #scoreCheckpoint(
    task: RepositoryTaskSpec,
    checkpoint: SandboxCheckpoint,
    appendEvidence: (evidence: CommandEvidence) => void,
    timeoutLimitMs: number,
  ): Promise<{ passed: boolean; exitCode: number | null }> {
    const snapshotDigest = await digestTree(checkpoint.workspaceDirectory);
    const scorerTask: RepositoryTaskSpec = {
      ...task,
      snapshotDirectory: checkpoint.workspaceDirectory,
      snapshotDigest,
      setupCommand: null,
    };
    let sandbox: TrialSandbox | null = null;
    try {
      sandbox = await this.sandboxDriver.create(scorerTask, {
        role: "scorer",
      });
      const hiddenCommand = {
        ...task.hiddenValidator,
        timeoutMs: Math.max(
          1,
          Math.min(task.hiddenValidator.timeoutMs, timeoutLimitMs),
        ),
        argv: task.hiddenValidator.argv.map((argument) =>
          argument === task.hiddenValidatorSourcePath
            ? (task.hiddenValidator.argv.find((candidate) =>
                candidate.startsWith("/scorer/"),
              ) ?? "/scorer/hidden-validator")
            : argument,
        ),
      };
      const result = await sandbox.execute("hidden-validator", hiddenCommand);
      appendEvidence(result.evidence);
      return {
        passed: result.ok && !result.evidence.outputOverflow,
        exitCode: result.evidence.exitCode,
      };
    } finally {
      if (sandbox) {
        await sandbox.dispose(false);
      }
    }
  }

  async run(input: {
    task: RepositoryTaskSpec;
    prompt: string;
    harness: WritableHarnessAdapter;
  }): Promise<WorkflowRunnerResult> {
    const task = repositoryTaskSpecSchema.parse(input.task);
    const declaredHarness = writableHarnessDescriptorSchema.parse(
      input.harness.descriptor,
    );
    const startedAt = new Date().toISOString();
    const initialTreeDigest = await digestTree(task.snapshotDirectory);
    const trialId = fingerprint({
      protocol: "agent-workflow-runner-v1",
      taskId: task.taskId,
      snapshotDigest: task.snapshotDigest,
      prompt: input.prompt,
      harness: declaredHarness,
      startedAt,
    });
    const commandLog: CommandEvidence[] = [];
    const appendEvidence = (evidence: CommandEvidence): void => {
      commandLog.push({ ...evidence, sequence: commandLog.length });
    };
    const checkpoints: ScoredCheckpoint[] = [];
    let sandbox: TrialSandbox | null = null;
    let probeSandbox: TrialSandbox | null = null;
    let sandboxControl: WorkflowRunnerResult["sandbox"] = null;
    let baseline: SandboxCheckpoint | null = null;
    let finalCheckpoint: SandboxCheckpoint | null = null;
    let retainedWorkspace: string | null = null;
    let visibleValidatorPassed = false;
    let hiddenValidatorPassed = false;
    let status: WorkflowRunnerStatus = "control-unavailable";
    let failure: WorkflowRunnerResult["failure"] = null;
    let transcript: WorkflowRunnerResult["transcript"] = EMPTY_TRANSCRIPT;
    let usage: WorkflowRunnerResult["usage"] = null;
    let harness = declaredHarness;
    let totalCommands = 0;
    let tokensToFirstPassingCheckpoint: number | null = null;
    const preservationErrors: string[] = [];
    const wallClockStarted = performance.now();
    const remainingTrialMs = (): number =>
      task.limits.wallClockMs - (performance.now() - wallClockStarted);
    const assertCentralBudget = (nextTurn = false): number => {
      const remaining = remainingTrialMs();
      if (remaining <= 0) {
        throw new Error("Resource violation: total trial wall-clock exceeded.");
      }
      if (nextTurn && checkpoints.length >= task.limits.maxTurns) {
        throw new Error("Resource violation: maxTurns exceeded.");
      }
      return Math.max(1, Math.floor(remaining));
    };
    const boundedCommand = (
      command: RepositoryTaskSpec["hiddenValidator"],
      remainingMs: number,
    ) => ({
      ...command,
      timeoutMs: Math.max(1, Math.min(command.timeoutMs, remainingMs)),
    });

    const finish = async (): Promise<WorkflowRunnerResult> => {
      let finalTreeDigest = initialTreeDigest;
      let changed: string[] = [];
      let unauthorized: string[] = [];
      let finalPatch = "";
      let finalPatchDigest = sha256("");
      try {
        if (baseline && finalCheckpoint) {
          finalTreeDigest = await digestTree(
            finalCheckpoint.workspaceDirectory,
          );
          await validateFinalTreeSafety(
            finalCheckpoint.workspaceDirectory,
            task.allowedPaths,
          );
          const patch = await generateTreePatch(
            baseline.workspaceDirectory,
            finalCheckpoint.workspaceDirectory,
          );
          changed = patch.changedPaths;
          unauthorized = unauthorizedChanges(changed, task.allowedPaths);
          finalPatch = patch.text;
          finalPatchDigest = patch.digest;
          if (unauthorized.length > 0 && status === "passed") {
            status = "policy-violation";
            failure = {
              stage: "final-path-policy",
              message: `Unauthorized changed paths: ${unauthorized.join(", ")}`,
            };
          }
        }
      } catch (error) {
        preservationErrors.push(
          `final-tree-preservation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (status === "passed") {
          status = "policy-violation";
        }
      }
      if (sandbox) {
        try {
          retainedWorkspace = await sandbox.dispose(
            this.options.retainFailedWorkspaces === true && status !== "passed",
          );
        } catch (error) {
          preservationErrors.push(
            `sandbox-disposal: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const completedAt = new Date().toISOString();
      const result: WorkflowRunnerResult = {
        protocolVersion: "agent-workflow-runner-v1",
        trialId,
        taskId: task.taskId,
        status,
        startedAt,
        completedAt,
        initialTreeDigest,
        finalTreeDigest,
        changedPaths: changed,
        unauthorizedChangedPaths: unauthorized,
        commandLog,
        checkpoints: checkpoints.map((checkpoint) => checkpoint.evidence),
        visibleValidatorPassed,
        hiddenValidatorPassed,
        tokensToFirstPassingCheckpoint,
        transcript,
        usage,
        finalPatch,
        finalPatchDigest,
        sandbox: sandboxControl,
        harness,
        failure,
        preservationErrors,
        retainedWorkspace,
      };
      return workflowRunnerResultSchema.parse(result);
    };

    try {
      probeSandbox = await this.sandboxDriver.create(task, {
        role: "harness-probe",
      });
      const activeProbeSandbox = probeSandbox;
      sandboxControl = activeProbeSandbox.control;
      harness = writableHarnessDescriptorSchema.parse(
        await input.harness.verify({
          execute: async (command) => {
            const execution = await activeProbeSandbox.execute(
              "harness",
              command,
            );
            appendEvidence(execution.evidence);
            return execution;
          },
        }),
      );
      await activeProbeSandbox.dispose(false);
      probeSandbox = null;
      if (harness.conformanceStatus !== "verified") {
        status = "control-unavailable";
        failure = {
          stage: "harness-conformance",
          message: `Harness is unverified: ${harness.blockReasons.join(", ")}`,
        };
        return await finish();
      }
      sandbox = await this.sandboxDriver.create(task, { role: "agent" });
      sandboxControl = sandbox.control;

      if (task.setupCommand) {
        const remaining = assertCentralBudget();
        const setup = await sandbox.execute(
          "setup",
          boundedCommand(task.setupCommand, remaining),
        );
        appendEvidence(setup.evidence);
        totalCommands += 1;
        if (!setup.ok || setup.evidence.outputOverflow) {
          status = failureStatus(
            setup.evidence.outputOverflow
              ? "setup output overflow"
              : setup.evidence.stderr,
            "setup-failed",
          );
          failure = {
            stage: "setup",
            message:
              setup.evidence.stderr ||
              `Setup exited ${String(setup.evidence.exitCode)}`,
          };
          return await finish();
        }
      }

      await sandbox.activateAgentPolicy();
      baseline = await sandbox.checkpoint("baseline");

      const checkpoint = async (params: {
        checkpointId: string;
        cumulativeModelTokens: number | null;
      }): Promise<void> => {
        assertCentralBudget(true);
        const captured = await sandbox!.checkpoint(params.checkpointId);
        const remaining = assertCentralBudget();
        const scored = await this.#scoreCheckpoint(
          task,
          captured,
          appendEvidence,
          remaining,
        );
        const evidence: CheckpointEvidence = {
          checkpointId: params.checkpointId,
          sequence: checkpoints.length,
          treeDigest: await digestTree(captured.workspaceDirectory),
          createdAt: new Date().toISOString(),
          hiddenValidatorPassed: scored.passed,
          hiddenValidatorExitCode: scored.exitCode,
          cumulativeModelTokens: params.cumulativeModelTokens,
          harnessStateDigests: captured.harnessStateDigests,
          harnessStateChanges: captured.harnessStateChanges,
        };
        checkpoints.push({ evidence, directory: captured.workspaceDirectory });
        if (
          scored.passed &&
          tokensToFirstPassingCheckpoint === null &&
          params.cumulativeModelTokens !== null
        ) {
          tokensToFirstPassingCheckpoint = params.cumulativeModelTokens;
        }
      };

      const harnessResult = await input.harness.run({
        task,
        prompt: input.prompt,
        execute: async (command) => {
          const remaining = assertCentralBudget();
          totalCommands += 1;
          if (totalCommands > task.limits.maxCommands) {
            throw new Error("Resource budget exceeded: maxCommands.");
          }
          const execution = await sandbox!.execute(
            "harness",
            boundedCommand(command, remaining),
          );
          appendEvidence(execution.evidence);
          if (execution.evidence.outputOverflow) {
            throw new Error("Resource violation: command output overflow.");
          }
          return execution;
        },
        checkpoint,
      });
      transcript = harnessResult.transcript;
      usage = harnessResult.usage;

      let visiblePassed = true;
      for (const visibleCommand of task.visibleChecks) {
        const remaining = assertCentralBudget();
        totalCommands += 1;
        if (totalCommands > task.limits.maxCommands) {
          throw new Error("Resource budget exceeded: maxCommands.");
        }
        const visible = await sandbox.execute(
          "visible-validator",
          boundedCommand(visibleCommand, remaining),
        );
        appendEvidence(visible.evidence);
        visiblePassed =
          visiblePassed && visible.ok && !visible.evidence.outputOverflow;
      }
      visibleValidatorPassed = visiblePassed;
      finalCheckpoint = await sandbox.checkpoint("final");
      const finalScoreBudget = assertCentralBudget();
      const finalScore = await this.#scoreCheckpoint(
        task,
        finalCheckpoint,
        appendEvidence,
        finalScoreBudget,
      );
      hiddenValidatorPassed = finalScore.passed;
      status = !harnessResult.completed
        ? failureStatus(
            harnessResult.failureMessage ?? "Harness failed.",
            "harness-failed",
          )
        : hiddenValidatorPassed
          ? "passed"
          : "validator-failed";
      failure = harnessResult.completed
        ? hiddenValidatorPassed
          ? null
          : {
              stage: "hidden-validator",
              message: `Hidden validator exited ${String(finalScore.exitCode)}`,
            }
        : {
            stage: "harness",
            message: harnessResult.failureMessage ?? "Harness failed.",
          };
      return await finish();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status = failureStatus(
        message,
        sandbox ? "harness-failed" : "control-unavailable",
      );
      failure = {
        stage: sandbox ? "execution" : "sandbox-probe",
        message,
      };
      if (sandbox && baseline) {
        try {
          finalCheckpoint = await sandbox.checkpoint("failed-final");
          const finalScore = await this.#scoreCheckpoint(
            task,
            finalCheckpoint,
            appendEvidence,
            task.hiddenValidator.timeoutMs,
          );
          hiddenValidatorPassed = finalScore.passed;
        } catch (checkpointError) {
          failure.message += `; failed-final preservation error: ${
            checkpointError instanceof Error
              ? checkpointError.message
              : String(checkpointError)
          }`;
        }
      }
      return await finish();
    } finally {
      if (probeSandbox) {
        await probeSandbox.dispose(false);
      }
      if (sandbox) {
        await sandbox.dispose(
          this.options.retainFailedWorkspaces === true && status !== "passed",
        );
      }
    }
  }
}
