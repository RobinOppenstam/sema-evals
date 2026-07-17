import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  toRepositoryTaskSpec,
  workflowAcquisitionReviewSchema,
  workflowCandidateInventorySchema,
  workflowContaminationReviewSchema,
  workflowCorpusManifestSchema,
  workflowCorpusResidualGateSchema,
  workflowCorpusSealSchema,
  workflowDeduplicationReportSchema,
  workflowLeakageReviewSchema,
  workflowLicenseReviewSchema,
  workflowTaskFamilyReviewSchema,
  workflowValidatorReviewSchema,
} from "../src/corpus-schemas.js";

const EXPERIMENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function parseYaml(path: string): Promise<unknown> {
  return YAML.parse(await readFile(path, "utf8")) as unknown;
}

describe("workflow corpus schemas", () => {
  it("records four sacrificial tasks without claiming confirmatory readiness", async () => {
    const manifest = workflowCorpusManifestSchema.parse(
      await parseYaml(
        resolve(
          EXPERIMENT_ROOT,
          "datasets/manifests/sacrificial-development.yaml",
        ),
      ),
    );
    const gate = workflowCorpusResidualGateSchema.parse(
      await parseYaml(
        resolve(EXPERIMENT_ROOT, "acquisition/residual-gate.yaml"),
      ),
    );
    const candidates = workflowCandidateInventorySchema.parse(
      await parseYaml(
        resolve(EXPERIMENT_ROOT, "acquisition/candidate-repositories.yaml"),
      ),
    );
    const seal = workflowCorpusSealSchema.parse(
      JSON.parse(
        await readFile(
          resolve(
            EXPERIMENT_ROOT,
            "datasets/seals/sacrificial-development.json",
          ),
          "utf8",
        ),
      ) as unknown,
    );

    expect(manifest).toMatchObject({
      status: "sealed",
      sealClass: "exploratory",
    });
    expect(manifest.tasks).toHaveLength(4);
    expect(gate).toMatchObject({
      status: "satisfied",
      requiredAcceptedTaskCount: 3,
      acceptedTaskCount: 4,
    });
    expect(candidates.acceptedTaskCount).toBe(4);
    expect(seal).toMatchObject({
      sealClass: "exploratory",
      readyForConfirmatoryRun: false,
      corpusDigest:
        "25b8b406c9e1fa38a1ead22b8e8c8b747714fba9b4933ab9b5c5929480994265",
    });
  });

  it("keeps every review template parseable but pending", async () => {
    const templates = resolve(EXPERIMENT_ROOT, "acquisition/templates");
    const parsed = [
      workflowLicenseReviewSchema.parse(
        await parseYaml(
          resolve(templates, "license-redistribution-review.yaml"),
        ),
      ),
      workflowAcquisitionReviewSchema.parse(
        await parseYaml(resolve(templates, "acquisition-review.yaml")),
      ),
      workflowValidatorReviewSchema.parse(
        await parseYaml(resolve(templates, "validator-review.yaml")),
      ),
      workflowTaskFamilyReviewSchema.parse(
        await parseYaml(resolve(templates, "task-family-review.yaml")),
      ),
      workflowContaminationReviewSchema.parse(
        await parseYaml(resolve(templates, "contamination-review.yaml")),
      ),
      workflowLeakageReviewSchema.parse(
        await parseYaml(resolve(templates, "leakage-review.yaml")),
      ),
      workflowDeduplicationReportSchema.parse(
        await parseYaml(resolve(templates, "deduplication-report.yaml")),
      ),
    ];

    expect(parsed.every(({ status }) => status === "pending")).toBe(true);
  });

  it("rejects a passing license review that does not permit modification", () => {
    const result = workflowLicenseReviewSchema.safeParse({
      schemaVersion: "workflow-license-review-v1",
      taskId: "task-1",
      status: "pass",
      licenseName: "Example",
      spdxId: null,
      primaryLicenseUrl: "https://example.com/license",
      licenseFilePath: "LICENSE",
      redistributionMode: "metadata-only",
      redistributionPermitted: true,
      modificationPermitted: false,
      retainCopyrightNotice: true,
      retainLicenseText: true,
      attributionRequirements: [],
      reviewer: "reviewer",
      reviewedAt: "2026-07-17T00:00:00.000Z",
      notes: [],
    });
    expect(result.success).toBe(false);
  });

  it("allows metadata-only acquisition when rebundling is not permitted", () => {
    const result = workflowLicenseReviewSchema.safeParse({
      schemaVersion: "workflow-license-review-v1",
      taskId: "task-1",
      status: "pass",
      licenseName: "Example",
      spdxId: null,
      primaryLicenseUrl: "https://example.com/license",
      licenseFilePath: "LICENSE",
      redistributionMode: "metadata-only",
      redistributionPermitted: false,
      modificationPermitted: true,
      retainCopyrightNotice: true,
      retainLicenseText: true,
      attributionRequirements: [],
      reviewer: "reviewer",
      reviewedAt: "2026-07-17T00:00:00.000Z",
      notes: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects task-family leakage across train, dev, and heldout", () => {
    const base = {
      schemaVersion: "workflow-corpus-manifest-v1",
      corpusId: "family-index-test",
      purpose: "heldout-evaluation",
      sealClass: "exploratory",
      status: "draft",
      ecosystem: "typescript-javascript",
      createdAt: "2026-07-17T00:00:00.000Z",
      sealedAt: null,
      taskFamilySplitMethod: "Exact family grouping.",
      tasks: [],
      exclusions: [],
      corpusReviews: [],
      residualGatePath: "acquisition/residual-gate.yaml",
    } as const;
    const result = workflowCorpusManifestSchema.safeParse({
      ...base,
      taskFamilyIndex: [
        {
          taskId: "train-task",
          split: "train",
          repository: "same",
          subsystem: "same",
          rootCause: "same",
          validator: "same",
          ancestryGroup: "same",
        },
        {
          taskId: "heldout-task",
          split: "heldout",
          repository: "same",
          subsystem: "same",
          rootCause: "same",
          validator: "same",
          ancestryGroup: "same",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("does not label a sub-30 heldout corpus confirmatory", () => {
    const result = workflowCorpusManifestSchema.safeParse({
      schemaVersion: "workflow-corpus-manifest-v1",
      corpusId: "too-small-confirmatory",
      purpose: "heldout-evaluation",
      sealClass: "confirmatory",
      status: "draft",
      ecosystem: "typescript-javascript",
      createdAt: "2026-07-17T00:00:00.000Z",
      sealedAt: null,
      taskFamilySplitMethod: "Exact family grouping.",
      taskFamilyIndex: [],
      tasks: [],
      exclusions: [],
      corpusReviews: [],
      residualGatePath: "acquisition/residual-gate.yaml",
    });
    expect(result.success).toBe(false);
  });

  it("projects accepted corpus tasks into the runner contract without policy loss", () => {
    const hash = "a".repeat(64);
    const task = {
      schemaVersion: "workflow-corpus-task-v1" as const,
      id: "task-1",
      title: "Example task",
      split: "train" as const,
      snapshotDirectory: "snapshots/task-1",
      snapshotDigest: hash,
      postFixSnapshotDigest: "b".repeat(64),
      resetProofDigest: hash,
      taskRequest: "Fix the regression without changing public behavior.",
      setupCommand: ["pnpm", "install", "--offline"],
      visibleChecks: [
        {
          name: "unit",
          command: ["pnpm", "test"],
          expectedExitCode: 0 as const,
        },
      ],
      hiddenValidator: {
        command: ["node", "validators/task-1.mjs"],
        sourcePath: "validators/task-1.mjs",
        sourceDigest: hash,
        deterministic: true as const,
        agentVisible: false as const,
        expectedPreFixExitCode: 1,
        expectedPostFixExitCode: 0 as const,
        outputSchemaVersion: "validator-v1",
      },
      allowedPaths: ["src"],
      prohibitedPaths: ["validators"],
      secrets: "none" as const,
      limits: {
        runtimeSeconds: 60,
        diskMegabytes: 512,
        memoryMegabytes: 512,
        maxProcesses: 32,
        cpus: 1,
        maxCommands: 20,
        maxTurns: 10,
      },
      offlineDependencies: {
        packageManager: "pnpm" as const,
        nodeVersion: "22.17.0",
        lockfilePath: "pnpm-lock.yaml",
        lockfileDigest: hash,
        cacheKind: "pnpm-store" as const,
        cachePath: "cache",
        cacheDigest: hash,
        restoreCommand: ["pnpm", "install", "--offline"],
        setupWritablePaths: ["node_modules"],
        networkRequired: false as const,
      },
      resetVerification: {
        materializeCommand: ["node", "reset/materialize.mjs"],
        resetCommand: ["node", "reset/materialize.mjs"],
        mutationProbePath: "src/index.ts",
        evidenceFiles: [
          {
            path: "reset/materialize.mjs",
            digest: hash,
          },
        ],
      },
      provenance: {
        repositoryUrl: "https://github.com/example/repo",
        sourceCommit: "c".repeat(40),
        upstreamPatchUrl:
          "https://github.com/example/repo/commit/" + "d".repeat(40),
        upstreamPatchDigest: hash,
        upstreamPatchMergedAt: "2026-07-17T00:00:00.000Z",
        acquiredAt: "2026-07-17T00:00:00.000Z",
        sourceArchiveUrl:
          "https://github.com/example/repo/archive/" +
          "c".repeat(40) +
          ".tar.gz",
        sourceArchiveDigest: hash,
        acquisitionInstructionsPath: "acquisition/task-1.md",
        licenseName: "MIT",
        licenseSpdx: "MIT",
        primaryLicenseUrl: "https://github.com/example/repo/blob/main/LICENSE",
        redistributionMode: "metadata-only" as const,
      },
      family: {
        repository: "example/repo",
        subsystem: "parser",
        rootCause: "boundary-check",
        validator: "behavioral",
        ancestryGroup: "example-task-1",
        sharedAncestryTaskIds: [],
      },
      inclusionRationale: "Independent regression with deterministic behavior.",
      preFixFails: true as const,
      postFixPasses: true as const,
      resetByteIdentical: true as const,
      reviewDocuments: [
        { kind: "license" as const, path: "r/license.yaml", digest: hash },
        {
          kind: "acquisition" as const,
          path: "r/acquisition.yaml",
          digest: hash,
        },
        { kind: "validator" as const, path: "r/validator.yaml", digest: hash },
        {
          kind: "task-family" as const,
          path: "r/family.yaml",
          digest: hash,
        },
        {
          kind: "contamination" as const,
          path: "r/contamination.yaml",
          digest: hash,
        },
        { kind: "leakage" as const, path: "r/leakage.yaml", digest: hash },
      ],
    };

    const projected = toRepositoryTaskSpec(task);
    expect(projected).toMatchObject({
      schemaVersion: "workflow-repository-task-v1",
      taskId: task.id,
      snapshotDirectory: task.snapshotDirectory,
      taskRequest: task.taskRequest,
      setupCommand: {
        argv: task.setupCommand,
        cwd: ".",
        timeoutMs: 60_000,
      },
      hiddenValidator: {
        argv: task.hiddenValidator.command,
        cwd: ".",
        timeoutMs: 60_000,
      },
      hiddenValidatorSourcePath: task.hiddenValidator.sourcePath,
      hiddenValidatorSourceDigest: task.hiddenValidator.sourceDigest,
      offlineDependencyCache: {
        digest: hash,
        mountPath: "/workflow-cache",
        setupWritablePaths: ["node_modules"],
      },
      allowedPaths: task.allowedPaths,
      prohibitedPaths: task.prohibitedPaths,
      limits: {
        wallClockMs: 60_000,
        commandTimeoutMs: 60_000,
        memoryBytes: 512 * 1024 * 1024,
        diskBytes: 512 * 1024 * 1024,
        pids: 32,
        cpus: 1,
        maxCommands: 20,
        maxTurns: 10,
      },
      provenance: {
        sourceRepository: task.provenance.repositoryUrl,
        sourceCommit: task.provenance.sourceCommit,
        licenseSpdx: "MIT",
        validatorDigest: task.hiddenValidator.sourceDigest,
        split: "train",
      },
    });
  });
});
