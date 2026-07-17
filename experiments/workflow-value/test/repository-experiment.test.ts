import {
  FixtureReferenceProvider,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";
import type { RepositoryTaskSpec } from "@sema-evals/workflow-runner";
import {
  DeterministicWritableHarnessAdapter,
  type AgentWorkflowRunner,
} from "@sema-evals/workflow-runner";
import { describe, expect, test } from "vitest";

import { loadFrozenWorkflowLibrary } from "../src/library.js";
import {
  buildRepositoryWorkflowDelivery,
  REPOSITORY_WORKFLOW_CONDITIONS,
  runRepositoryWorkflowTrial,
} from "../src/repository-experiment.js";

const task: RepositoryTaskSpec = {
  schemaVersion: "workflow-repository-task-v1",
  taskId: "delivery-test",
  snapshotDirectory: ".",
  snapshotDigest: "0".repeat(64),
  taskRequest: "Fix the observable repository behavior.",
  setupCommand: null,
  visibleChecks: [
    { argv: ["node", "--test"], cwd: ".", env: {}, timeoutMs: 1000 },
  ],
  hiddenValidator: {
    argv: ["node", "/scorer/hidden-validator.mjs"],
    cwd: ".",
    env: {},
    timeoutMs: 1000,
  },
  hiddenValidatorSourcePath: "hidden-validator.mjs",
  hiddenValidatorSourceDigest: "1".repeat(64),
  offlineDependencyCache: null,
  allowedPaths: ["src"],
  prohibitedPaths: [".git"],
  limits: {
    wallClockMs: 10_000,
    commandTimeoutMs: 1000,
    memoryBytes: 1,
    diskBytes: 1,
    pids: 1,
    cpus: 1,
    maxCommands: 1,
    maxTurns: 1,
  },
  provenance: {
    sourceRepository: "https://example.invalid",
    sourceCommit: "0".repeat(40),
    licenseSpdx: "MIT",
    acquisitionDigest: "2".repeat(64),
    validatorDigest: "1".repeat(64),
    familyId: "3".repeat(64),
    split: "dev",
  },
};

describe("repository workflow delivery", () => {
  test("keeps resolved content identical across prose, opaque, and addressed delivery", async () => {
    const provider: SemanticReferenceProvider = new FixtureReferenceProvider();
    const library = await loadFrozenWorkflowLibrary();
    const deliveries = await Promise.all(
      REPOSITORY_WORKFLOW_CONDITIONS.map((condition) =>
        buildRepositoryWorkflowDelivery(task, condition, library, provider),
      ),
    );
    const treatmentDigests = deliveries
      .slice(1)
      .map(({ resolvedContentDigest }) => resolvedContentDigest);
    expect(new Set(treatmentDigests).size).toBe(1);
    expect(deliveries[0]?.resolvedContentDigest).toBeNull();
    expect(deliveries[1]?.hydrationBytes).toBe(0);
    expect(deliveries[2]?.hydrationBytes).toBeGreaterThan(0);
    expect(deliveries[1]?.contextPayloadBytes).toBe(
      deliveries[2]?.contextPayloadBytes,
    );
  });

  test("separates repair notification and enforcement", async () => {
    const provider = new FixtureReferenceProvider();
    const library = await loadFrozenWorkflowLibrary();
    const repair = await buildRepositoryWorkflowDelivery(
      task,
      "content-addressed-notified-repair",
      library,
      provider,
    );
    const enforced = await buildRepositoryWorkflowDelivery(
      task,
      "content-addressed-enforced",
      library,
      provider,
    );
    expect(repair.mismatchNotice).toBeTruthy();
    expect(repair.enforced).toBe(false);
    expect(enforced.enforced).toBe(true);
    const blocked = await buildRepositoryWorkflowDelivery(
      task,
      "content-addressed-enforced",
      library,
      provider,
      { forceResolutionFailure: true },
    );
    expect(blocked.canonicalVerified).toBe(false);
    expect(blocked.agentStartAllowed).toBe(false);
    expect(blocked.stateTransitions).toContain("enforcement-blocked");
  });

  test("does not invoke the runner when enforcement verification fails", async () => {
    let invoked = false;
    const runner = {
      run: async () => {
        invoked = true;
        throw new Error("runner must not start");
      },
    } as unknown as AgentWorkflowRunner;
    const result = await runRepositoryWorkflowTrial({
      task,
      condition: "content-addressed-enforced",
      harness: new DeterministicWritableHarnessAdapter([]),
      runner,
      referenceProvider: new FixtureReferenceProvider(),
      datasetDigest: "4".repeat(64),
      scorerFingerprint: "5".repeat(64),
      vocabularyRoot: "",
      forceResolutionFailure: true,
    });
    expect(invoked).toBe(false);
    expect(result.executionStatus).toBe("enforcement-blocked");
    expect(result.runnerResult).toBeNull();
  });
});
