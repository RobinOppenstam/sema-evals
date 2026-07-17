import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { sha256Text, stableJson } from "@sema-evals/core";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  buildCorpusSeal,
  fingerprintDirectory,
  verifyCorpusSeal,
} from "../src/corpus-seal.js";
import type {
  WorkflowCorpusManifest,
  WorkflowCorpusTask,
} from "../src/corpus-schemas.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "workflow-corpus-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function writeEvidence(
  root: string,
  path: string,
  value: unknown,
): Promise<string> {
  const absolutePath = join(root, path);
  await mkdir(resolve(absolutePath, ".."), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(absolutePath, raw, "utf8");
  return sha256Text(raw);
}

async function makeTask(
  root: string,
  id: string,
  split: "train" | "dev",
  options: {
    independentReviewers?: boolean;
    brokenReset?: boolean;
  } = {},
): Promise<WorkflowCorpusTask> {
  const snapshotDirectory = `snapshots/${id}`;
  const cachePath = `cache/${id}`;
  const hiddenValidatorPath = `validators/${id}.mjs`;
  const lockfilePath = `locks/${id}.yaml`;
  const acquisitionInstructionsPath = `instructions/${id}.md`;
  const resetScriptPath = `reset/${id}.mjs`;

  await mkdir(join(root, snapshotDirectory, "src"), { recursive: true });
  await writeFile(
    join(root, snapshotDirectory, "src/index.ts"),
    `export const task = ${JSON.stringify(id)};\n`,
    "utf8",
  );
  await mkdir(join(root, cachePath), { recursive: true });
  await writeFile(join(root, cachePath, "metadata.json"), "{}\n", "utf8");
  await mkdir(join(root, "validators"), { recursive: true });
  await writeFile(
    join(root, hiddenValidatorPath),
    "process.exit(0);\n",
    "utf8",
  );
  await mkdir(join(root, "locks"), { recursive: true });
  await writeFile(join(root, lockfilePath), "lockfileVersion: 9\n", "utf8");
  await mkdir(join(root, "instructions"), { recursive: true });
  await writeFile(
    join(root, acquisitionInstructionsPath),
    `Acquire ${id} from its immutable source commit.\n`,
    "utf8",
  );
  await mkdir(join(root, "reset"), { recursive: true });
  await writeFile(
    join(root, resetScriptPath),
    [
      'import { cp, rm } from "node:fs/promises";',
      'import { join } from "node:path";',
      `const source = join(process.cwd(), ${JSON.stringify(snapshotDirectory)});`,
      "const target = process.env.WORKFLOW_TASK_WORKSPACE;",
      'if (!target) throw new Error("WORKFLOW_TASK_WORKSPACE is required.");',
      options.brokenReset
        ? 'if (process.argv[2] === "reset") process.exit(0);'
        : "",
      "await rm(target, { recursive: true, force: true });",
      "await cp(source, target, { recursive: true });",
      "",
    ].join("\n"),
    "utf8",
  );

  const snapshotDigest = await fingerprintDirectory(
    join(root, snapshotDirectory),
  );
  const cacheDigest = await fingerprintDirectory(join(root, cachePath));
  const hiddenValidatorDigest = sha256Text(
    await readFile(join(root, hiddenValidatorPath), "utf8"),
  );
  const lockfileDigest = sha256Text(
    await readFile(join(root, lockfilePath), "utf8"),
  );
  const resetScriptDigest = sha256Text(
    await readFile(join(root, resetScriptPath), "utf8"),
  );
  const sourceCommit = sha256Text(`commit-${id}`).slice(0, 40);
  const patchCommit = sha256Text(`patch-${id}`).slice(0, 40);
  const patchDigest = sha256Text(`patch-body-${id}`);
  const postFixSnapshotDigest = sha256Text(`post-fix-${id}`);
  const commonReview = {
    taskId: id,
    status: "pass",
    reviewer: "independent-reviewer",
    reviewedAt: "2026-07-17T00:00:00.000Z",
    notes: ["Synthetic seal test evidence."],
  } as const;

  const reviews = [
    {
      kind: "license" as const,
      path: `reviews/${id}/license.json`,
      value: {
        schemaVersion: "workflow-license-review-v1",
        ...commonReview,
        licenseName: "MIT",
        spdxId: "MIT",
        primaryLicenseUrl: "https://github.com/example/repo/blob/main/LICENSE",
        licenseFilePath: "LICENSE",
        redistributionMode: "metadata-only",
        redistributionPermitted: true,
        modificationPermitted: true,
        retainCopyrightNotice: true,
        retainLicenseText: true,
        attributionRequirements: ["Retain license text."],
      },
    },
    {
      kind: "acquisition" as const,
      path: `reviews/${id}/acquisition.json`,
      value: {
        schemaVersion: "workflow-acquisition-review-v1",
        ...commonReview,
        reviewer: "acquisition-reviewer",
        repositoryUrl: "https://github.com/example/repo",
        sourceCommit,
        upstreamPatchUrl: `https://github.com/example/repo/commit/${patchCommit}`,
        upstreamPatchDigest: patchDigest,
        acquiredAt: "2026-07-17T00:00:00.000Z",
        acquisitionInstructionsPath,
        sourceArchiveUrl: `https://github.com/example/repo/archive/${sourceCommit}.tar.gz`,
        sourceArchiveDigest: sha256Text(`archive-${id}`),
        preFixSnapshotPath: snapshotDirectory,
        preFixSnapshotDigest: snapshotDigest,
        postFixSnapshotDigest,
        resetProofDigest: snapshotDigest,
        immutableSourceEvidence: [
          `https://github.com/example/repo/tree/${sourceCommit}`,
          `https://github.com/example/repo/commit/${patchCommit}`,
        ],
      },
    },
    {
      kind: "validator" as const,
      path: `reviews/${id}/validator.json`,
      value: {
        schemaVersion: "workflow-validator-review-v1",
        ...commonReview,
        reviewer:
          options.independentReviewers === false
            ? "acquisition-reviewer"
            : "validator-reviewer",
        hiddenValidatorPath,
        hiddenValidatorDigest,
        deterministic: true,
        agentVisible: false,
        preFixExitCode: 1,
        postFixExitCode: 0,
        preFixOutputDigest: sha256Text(`pre-fail-${id}`),
        postFixOutputDigest: sha256Text(`post-pass-${id}`),
        visibleChecks: [
          {
            name: "unit",
            preFixExitCode: 0,
            postFixExitCode: 0,
            preFixOutputDigest: sha256Text(`visible-pre-${id}`),
            postFixOutputDigest: sha256Text(`visible-post-${id}`),
          },
        ],
        falsePositiveChecks: ["A mutation that keeps the defect still fails."],
      },
    },
    {
      kind: "task-family" as const,
      path: `reviews/${id}/task-family.json`,
      value: {
        schemaVersion: "workflow-task-family-review-v1",
        ...commonReview,
        repositoryFamily: `example/${id}`,
        subsystemFamily: `subsystem-${id}`,
        rootCauseFamily: `root-${id}`,
        validatorFamily: `validator-${id}`,
        ancestryGroup: `ancestry-${id}`,
        sharedAncestryTaskIds: [],
        assignedSplit: split,
        rationale: "Independent synthetic family for seal testing.",
      },
    },
    {
      kind: "contamination" as const,
      path: `reviews/${id}/contamination.json`,
      value: {
        schemaVersion: "workflow-contamination-review-v1",
        ...commonReview,
        upstreamPatchMergedAt: "2026-07-17T00:00:00.000Z",
        modelCutoffComparisons: [
          {
            model: "test-model",
            cutoffDate: "2025-01-01",
            relation: "post-cutoff",
            evidenceUrl: "https://example.com/model-card",
            rationale:
              "The synthetic patch date follows the documented cutoff.",
          },
        ],
        searchablePatchTextRemovedFromPrompt: true,
      },
    },
    {
      kind: "leakage" as const,
      path: `reviews/${id}/leakage.json`,
      value: {
        schemaVersion: "workflow-leakage-review-v1",
        ...commonReview,
        taskRequestContainsSolution: false,
        visibleChecksContainHiddenAssertions: false,
        workspaceContainsPostFixPatch: false,
        workspaceContainsValidatorSource: false,
        filenamesRevealSolution: false,
        commentsRevealSolution: false,
        automatedScanDigest: sha256Text(`leakage-scan-${id}`),
      },
    },
  ];
  const reviewDocuments = [];
  for (const review of reviews) {
    reviewDocuments.push({
      kind: review.kind,
      path: review.path,
      digest: await writeEvidence(root, review.path, review.value),
    });
  }

  return {
    schemaVersion: "workflow-corpus-task-v1",
    id,
    title: `Task ${id}`,
    split,
    snapshotDirectory,
    snapshotDigest,
    postFixSnapshotDigest,
    resetProofDigest: snapshotDigest,
    taskRequest: `Repair ${id} while preserving its public API.`,
    setupCommand: ["pnpm", "install", "--offline", "--frozen-lockfile"],
    visibleChecks: [
      {
        name: "unit",
        command: ["pnpm", "test"],
        expectedExitCode: 0,
      },
    ],
    hiddenValidator: {
      command: ["node", hiddenValidatorPath],
      sourcePath: hiddenValidatorPath,
      sourceDigest: hiddenValidatorDigest,
      deterministic: true,
      agentVisible: false,
      expectedPreFixExitCode: 1,
      expectedPostFixExitCode: 0,
      outputSchemaVersion: "workflow-hidden-validator-v1",
    },
    allowedPaths: ["src"],
    prohibitedPaths: ["validators", "reviews"],
    secrets: "none",
    limits: {
      runtimeSeconds: 120,
      diskMegabytes: 512,
      memoryMegabytes: 512,
      maxProcesses: 32,
      cpus: 1,
      maxCommands: 20,
      maxTurns: 10,
    },
    offlineDependencies: {
      packageManager: "pnpm",
      nodeVersion: "22.17.0",
      lockfilePath,
      lockfileDigest,
      cacheKind: "pnpm-store",
      cachePath,
      cacheDigest,
      restoreCommand: ["pnpm", "install", "--offline", "--frozen-lockfile"],
      setupWritablePaths: ["node_modules"],
      networkRequired: false,
    },
    resetVerification: {
      materializeCommand: ["node", resetScriptPath, "materialize"],
      resetCommand: ["node", resetScriptPath, "reset"],
      mutationProbePath: "src/index.ts",
      evidenceFiles: [
        {
          path: resetScriptPath,
          digest: resetScriptDigest,
        },
      ],
    },
    provenance: {
      repositoryUrl: "https://github.com/example/repo",
      sourceCommit,
      upstreamPatchUrl: `https://github.com/example/repo/commit/${patchCommit}`,
      upstreamPatchDigest: patchDigest,
      upstreamPatchMergedAt: "2026-07-17T00:00:00.000Z",
      acquiredAt: "2026-07-17T00:00:00.000Z",
      sourceArchiveUrl: `https://github.com/example/repo/archive/${sourceCommit}.tar.gz`,
      sourceArchiveDigest: sha256Text(`archive-${id}`),
      acquisitionInstructionsPath,
      licenseName: "MIT",
      licenseSpdx: "MIT",
      primaryLicenseUrl: "https://github.com/example/repo/blob/main/LICENSE",
      redistributionMode: "metadata-only",
    },
    family: {
      repository: `example/${id}`,
      subsystem: `subsystem-${id}`,
      rootCause: `root-${id}`,
      validator: `validator-${id}`,
      ancestryGroup: `ancestry-${id}`,
      sharedAncestryTaskIds: [],
    },
    inclusionRationale:
      "Independent repository regression with deterministic validation.",
    preFixFails: true,
    postFixPasses: true,
    resetByteIdentical: true,
    reviewDocuments,
  };
}

async function makeSealableCorpus(
  root: string,
  options: {
    independentReviewers?: boolean;
    brokenReset?: boolean;
  } = {},
): Promise<string> {
  const corpusId = "test-sacrificial-corpus";
  const tasks = await Promise.all([
    makeTask(root, "task-a", "train", options),
    makeTask(root, "task-b", "train"),
    makeTask(root, "task-c", "dev"),
  ]);
  const deduplicationPath = "reviews/deduplication.json";
  const deduplicationDigest = await writeEvidence(root, deduplicationPath, {
    schemaVersion: "workflow-deduplication-report-v1",
    corpusId,
    status: "pass",
    exactDuplicateGroups: [],
    nearDuplicateGroups: [],
    familyConflicts: [],
    excludedTaskIds: [],
    method: "Exact digests plus independent family labels.",
    reviewer: "independent-reviewer",
    reviewedAt: "2026-07-17T00:00:00.000Z",
    notes: ["Synthetic seal test evidence."],
  });
  const manifest: WorkflowCorpusManifest = {
    schemaVersion: "workflow-corpus-manifest-v1",
    corpusId,
    purpose: "sacrificial-development",
    sealClass: "exploratory",
    status: "sealed",
    ecosystem: "typescript-javascript",
    createdAt: "2026-07-17T00:00:00.000Z",
    sealedAt: "2026-07-17T01:00:00.000Z",
    taskFamilySplitMethod:
      "Repository, subsystem, root-cause, and validator families are grouped.",
    taskFamilyIndex: tasks.map((task) => ({
      taskId: task.id,
      split: task.split,
      repository: task.family.repository,
      subsystem: task.family.subsystem,
      rootCause: task.family.rootCause,
      validator: task.family.validator,
      ancestryGroup: task.family.ancestryGroup,
    })),
    tasks,
    exclusions: [],
    corpusReviews: [
      {
        kind: "deduplication",
        path: deduplicationPath,
        digest: deduplicationDigest,
      },
    ],
    residualGatePath: null,
  };
  const manifestPath = join(root, "manifest.yaml");
  await writeFile(manifestPath, YAML.stringify(manifest), "utf8");
  return manifestPath;
}

describe("workflow corpus seal", () => {
  it("produces and verifies a deterministic seal over tasks and evidence", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = await makeSealableCorpus(root);

    const first = await buildCorpusSeal({ manifestPath, evidenceRoot: root });
    const second = await buildCorpusSeal({ manifestPath, evidenceRoot: root });
    expect(stableJson(first)).toBe(stableJson(second));
    expect(first.taskDigests).toHaveLength(3);

    const sealPath = join(root, "seal.json");
    await writeFile(sealPath, `${JSON.stringify(first, null, 2)}\n`, "utf8");
    await expect(
      verifyCorpusSeal({ manifestPath, evidenceRoot: root, sealPath }),
    ).resolves.toEqual(first);
  });

  it("fails closed when sealed evidence changes", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = await makeSealableCorpus(root);
    const seal = await buildCorpusSeal({ manifestPath, evidenceRoot: root });
    const sealPath = join(root, "seal.json");
    await writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`, "utf8");

    await writeFile(
      join(root, "reviews/task-a/leakage.json"),
      '{"tampered":true}\n',
      "utf8",
    );
    await expect(
      verifyCorpusSeal({ manifestPath, evidenceRoot: root, sealPath }),
    ).rejects.toThrow("Evidence digest mismatch");
  });

  it("requires independent acquisition and validator reviewers", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = await makeSealableCorpus(root, {
      independentReviewers: false,
    });
    await expect(
      buildCorpusSeal({ manifestPath, evidenceRoot: root }),
    ).rejects.toThrow("different acquisition and validator reviewers");
  });

  it("rejects a reset command that cannot restore the materialized snapshot", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = await makeSealableCorpus(root, {
      brokenReset: true,
    });
    await expect(
      buildCorpusSeal({ manifestPath, evidenceRoot: root }),
    ).rejects.toThrow("did not restore the pre-fix snapshot digest");
  });

  it("refuses to seal a draft residual manifest", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "draft.yaml");
    await writeFile(
      manifestPath,
      YAML.stringify({
        schemaVersion: "workflow-corpus-manifest-v1",
        corpusId: "draft-corpus",
        purpose: "sacrificial-development",
        sealClass: "exploratory",
        status: "draft",
        ecosystem: "typescript-javascript",
        createdAt: "2026-07-17T00:00:00.000Z",
        sealedAt: null,
        taskFamilySplitMethod: "Family grouping pending acquisition.",
        taskFamilyIndex: [],
        tasks: [],
        exclusions: [],
        corpusReviews: [],
        residualGatePath: "acquisition/residual-gate.yaml",
      }),
      "utf8",
    );
    await expect(
      buildCorpusSeal({ manifestPath, evidenceRoot: root }),
    ).rejects.toThrow("Only a completed manifest");
  });
});
