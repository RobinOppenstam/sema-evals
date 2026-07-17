import { resolve } from "node:path";

import { fingerprint } from "@sema-evals/core";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const nonEmptyStringSchema = z.string().trim().min(1);
const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !value.startsWith("/") && !value.split("/").includes(".."),
    {
      message: "Path must be repository-relative and may not traverse upward.",
    },
  );
const commandSchema = z.array(nonEmptyStringSchema).min(1);

export const workflowCorpusSplitSchema = z.enum(["train", "dev", "heldout"]);

export const workflowLicenseReviewSchema = z
  .object({
    schemaVersion: z.literal("workflow-license-review-v1"),
    taskId: nonEmptyStringSchema,
    status: z.enum(["pending", "pass", "fail"]),
    licenseName: nonEmptyStringSchema,
    spdxId: nonEmptyStringSchema.nullable(),
    primaryLicenseUrl: z.string().url(),
    licenseFilePath: relativePathSchema,
    redistributionMode: z.enum([
      "bundled-source",
      "metadata-only",
      "not-redistributable",
    ]),
    redistributionPermitted: z.boolean(),
    modificationPermitted: z.boolean(),
    retainCopyrightNotice: z.boolean(),
    retainLicenseText: z.boolean(),
    attributionRequirements: z.array(nonEmptyStringSchema),
    reviewer: nonEmptyStringSchema,
    reviewedAt: z.string().datetime({ offset: true }),
    notes: z.array(nonEmptyStringSchema),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.status === "pass" && !review.modificationPermitted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A passing license review must permit local modification.",
        path: ["status"],
      });
    }
    if (
      review.redistributionMode === "bundled-source" &&
      !review.redistributionPermitted
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bundled source requires redistribution permission.",
        path: ["redistributionMode"],
      });
    }
  });

export const workflowAcquisitionReviewSchema = z
  .object({
    schemaVersion: z.literal("workflow-acquisition-review-v1"),
    taskId: nonEmptyStringSchema,
    status: z.enum(["pending", "pass", "fail"]),
    repositoryUrl: z.string().url(),
    sourceCommit: commitShaSchema,
    upstreamPatchUrl: z.string().url(),
    upstreamPatchDigest: sha256Schema,
    acquiredAt: z.string().datetime({ offset: true }),
    acquisitionInstructionsPath: relativePathSchema,
    sourceArchiveUrl: z.string().url(),
    sourceArchiveDigest: sha256Schema,
    preFixSnapshotPath: relativePathSchema,
    preFixSnapshotDigest: sha256Schema,
    postFixSnapshotDigest: sha256Schema,
    resetProofDigest: sha256Schema,
    immutableSourceEvidence: z.array(z.string().url()).min(2),
    reviewer: nonEmptyStringSchema,
    reviewedAt: z.string().datetime({ offset: true }),
    notes: z.array(nonEmptyStringSchema),
  })
  .strict();

export const workflowValidatorReviewSchema = z
  .object({
    schemaVersion: z.literal("workflow-validator-review-v1"),
    taskId: nonEmptyStringSchema,
    status: z.enum(["pending", "pass", "fail"]),
    hiddenValidatorPath: relativePathSchema,
    hiddenValidatorDigest: sha256Schema,
    deterministic: z.literal(true),
    agentVisible: z.literal(false),
    preFixExitCode: z.number().int().min(1),
    postFixExitCode: z.literal(0),
    preFixOutputDigest: sha256Schema,
    postFixOutputDigest: sha256Schema,
    visibleChecks: z
      .array(
        z
          .object({
            name: nonEmptyStringSchema,
            preFixExitCode: z.number().int().nonnegative(),
            postFixExitCode: z.literal(0),
            preFixOutputDigest: sha256Schema,
            postFixOutputDigest: sha256Schema,
          })
          .strict(),
      )
      .min(1),
    falsePositiveChecks: z.array(nonEmptyStringSchema).min(1),
    reviewer: nonEmptyStringSchema,
    reviewedAt: z.string().datetime({ offset: true }),
    notes: z.array(nonEmptyStringSchema),
  })
  .strict();

export const workflowTaskFamilyReviewSchema = z
  .object({
    schemaVersion: z.literal("workflow-task-family-review-v1"),
    taskId: nonEmptyStringSchema,
    status: z.enum(["pending", "pass", "fail"]),
    repositoryFamily: nonEmptyStringSchema,
    subsystemFamily: nonEmptyStringSchema,
    rootCauseFamily: nonEmptyStringSchema,
    validatorFamily: nonEmptyStringSchema,
    ancestryGroup: nonEmptyStringSchema,
    sharedAncestryTaskIds: z.array(nonEmptyStringSchema),
    assignedSplit: workflowCorpusSplitSchema,
    reviewer: nonEmptyStringSchema,
    reviewedAt: z.string().datetime({ offset: true }),
    rationale: nonEmptyStringSchema,
    notes: z.array(nonEmptyStringSchema),
  })
  .strict();

export const workflowDeduplicationReportSchema = z
  .object({
    schemaVersion: z.literal("workflow-deduplication-report-v1"),
    corpusId: nonEmptyStringSchema,
    status: z.enum(["pending", "pass", "fail"]),
    exactDuplicateGroups: z.array(z.array(nonEmptyStringSchema).min(2)),
    nearDuplicateGroups: z.array(z.array(nonEmptyStringSchema).min(2)),
    familyConflicts: z.array(z.array(nonEmptyStringSchema).min(2)),
    excludedTaskIds: z.array(nonEmptyStringSchema),
    method: nonEmptyStringSchema,
    reviewer: nonEmptyStringSchema,
    reviewedAt: z.string().datetime({ offset: true }),
    notes: z.array(nonEmptyStringSchema),
  })
  .strict();

export const workflowContaminationReviewSchema = z
  .object({
    schemaVersion: z.literal("workflow-contamination-review-v1"),
    taskId: nonEmptyStringSchema,
    status: z.enum(["pending", "pass", "fail"]),
    upstreamPatchMergedAt: z.string().datetime({ offset: true }),
    modelCutoffComparisons: z
      .array(
        z
          .object({
            model: nonEmptyStringSchema,
            cutoffDate: z.string().date().nullable(),
            relation: z.enum(["post-cutoff", "pretraining-risk", "unknown"]),
            evidenceUrl: z.string().url(),
            rationale: nonEmptyStringSchema,
          })
          .strict(),
      )
      .min(1),
    searchablePatchTextRemovedFromPrompt: z.boolean(),
    reviewer: nonEmptyStringSchema,
    reviewedAt: z.string().datetime({ offset: true }),
    notes: z.array(nonEmptyStringSchema),
  })
  .strict()
  .superRefine((review, context) => {
    for (const [index, comparison] of review.modelCutoffComparisons.entries()) {
      if (comparison.relation !== "unknown" && comparison.cutoffDate === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A known cutoff relation requires a documented cutoff date.",
          path: ["modelCutoffComparisons", index, "cutoffDate"],
        });
      }
    }
  });

export const workflowLeakageReviewSchema = z
  .object({
    schemaVersion: z.literal("workflow-leakage-review-v1"),
    taskId: nonEmptyStringSchema,
    status: z.enum(["pending", "pass", "fail"]),
    taskRequestContainsSolution: z.literal(false),
    visibleChecksContainHiddenAssertions: z.literal(false),
    workspaceContainsPostFixPatch: z.literal(false),
    workspaceContainsValidatorSource: z.literal(false),
    filenamesRevealSolution: z.literal(false),
    commentsRevealSolution: z.literal(false),
    automatedScanDigest: sha256Schema,
    reviewer: nonEmptyStringSchema,
    reviewedAt: z.string().datetime({ offset: true }),
    notes: z.array(nonEmptyStringSchema),
  })
  .strict();

export const workflowReviewDocumentRefSchema = z
  .object({
    kind: z.enum([
      "license",
      "acquisition",
      "validator",
      "task-family",
      "contamination",
      "leakage",
    ]),
    path: relativePathSchema,
    digest: sha256Schema,
  })
  .strict();

const visibleCheckSchema = z
  .object({
    name: nonEmptyStringSchema,
    command: commandSchema,
    expectedExitCode: z.literal(0),
  })
  .strict();

const hiddenValidatorSchema = z
  .object({
    command: commandSchema,
    sourcePath: relativePathSchema,
    sourceDigest: sha256Schema,
    deterministic: z.literal(true),
    agentVisible: z.literal(false),
    expectedPreFixExitCode: z.number().int().min(1),
    expectedPostFixExitCode: z.literal(0),
    outputSchemaVersion: nonEmptyStringSchema,
  })
  .strict();

const offlineDependenciesSchema = z
  .object({
    packageManager: z.enum(["pnpm", "npm", "yarn"]),
    nodeVersion: nonEmptyStringSchema,
    lockfilePath: relativePathSchema,
    lockfileDigest: sha256Schema,
    cacheKind: z.enum(["pnpm-store", "npm-cache", "yarn-cache"]),
    cachePath: relativePathSchema,
    cacheDigest: sha256Schema,
    restoreCommand: commandSchema,
    setupWritablePaths: z.array(relativePathSchema),
    networkRequired: z.literal(false),
  })
  .strict();

const resourceLimitsSchema = z
  .object({
    runtimeSeconds: z.number().int().positive().max(3600),
    diskMegabytes: z.number().int().positive(),
    memoryMegabytes: z.number().int().positive(),
    maxProcesses: z.number().int().positive(),
    cpus: z.number().positive(),
    maxCommands: z.number().int().positive(),
    maxTurns: z.number().int().positive(),
  })
  .strict();

const resetVerificationSchema = z
  .object({
    materializeCommand: commandSchema,
    resetCommand: commandSchema,
    mutationProbePath: relativePathSchema,
    evidenceFiles: z
      .array(
        z
          .object({
            path: relativePathSchema,
            digest: sha256Schema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const provenanceSchema = z
  .object({
    repositoryUrl: z.string().url(),
    sourceCommit: commitShaSchema,
    upstreamPatchUrl: z.string().url(),
    upstreamPatchDigest: sha256Schema,
    upstreamPatchMergedAt: z.string().datetime({ offset: true }),
    acquiredAt: z.string().datetime({ offset: true }),
    sourceArchiveUrl: z.string().url(),
    sourceArchiveDigest: sha256Schema,
    acquisitionInstructionsPath: relativePathSchema,
    licenseName: nonEmptyStringSchema,
    licenseSpdx: nonEmptyStringSchema,
    primaryLicenseUrl: z.string().url(),
    redistributionMode: z.enum(["bundled-source", "metadata-only"]),
  })
  .strict();

export const workflowCorpusTaskSchema = z
  .object({
    schemaVersion: z.literal("workflow-corpus-task-v1"),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: nonEmptyStringSchema,
    split: workflowCorpusSplitSchema,
    snapshotDirectory: relativePathSchema,
    snapshotDigest: sha256Schema,
    postFixSnapshotDigest: sha256Schema,
    resetProofDigest: sha256Schema,
    taskRequest: nonEmptyStringSchema,
    setupCommand: commandSchema,
    visibleChecks: z.array(visibleCheckSchema).min(1),
    hiddenValidator: hiddenValidatorSchema,
    allowedPaths: z.array(relativePathSchema).min(1),
    prohibitedPaths: z.array(relativePathSchema).min(1),
    secrets: z.literal("none"),
    limits: resourceLimitsSchema,
    offlineDependencies: offlineDependenciesSchema,
    resetVerification: resetVerificationSchema,
    provenance: provenanceSchema,
    family: z
      .object({
        repository: nonEmptyStringSchema,
        subsystem: nonEmptyStringSchema,
        rootCause: nonEmptyStringSchema,
        validator: nonEmptyStringSchema,
        ancestryGroup: nonEmptyStringSchema,
        sharedAncestryTaskIds: z.array(nonEmptyStringSchema),
      })
      .strict(),
    inclusionRationale: nonEmptyStringSchema,
    preFixFails: z.literal(true),
    postFixPasses: z.literal(true),
    resetByteIdentical: z.literal(true),
    reviewDocuments: z.array(workflowReviewDocumentRefSchema).length(6),
  })
  .strict()
  .superRefine((task, context) => {
    const reviewKinds = new Set(task.reviewDocuments.map(({ kind }) => kind));
    if (reviewKinds.size !== 6) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each task requires one review document of every review kind.",
        path: ["reviewDocuments"],
      });
    }
    const overlap = task.allowedPaths.filter((path) =>
      task.prohibitedPaths.includes(path),
    );
    if (overlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Allowed and prohibited paths overlap: ${overlap.join(", ")}`,
        path: ["allowedPaths"],
      });
    }
  });

export const workflowCorpusExclusionSchema = z
  .object({
    candidateId: nonEmptyStringSchema,
    repositoryUrl: z.string().url(),
    reasonCode: z.enum([
      "license",
      "redistribution",
      "offline-dependencies",
      "validator",
      "family-overlap",
      "contamination",
      "leakage",
      "acquisition",
    ]),
    evidence: nonEmptyStringSchema,
  })
  .strict();

export const workflowCandidateInventorySchema = z
  .object({
    schemaVersion: z.literal("workflow-candidate-inventory-v1"),
    status: z.enum([
      "repository-and-license-screened-only",
      "sacrificial-tasks-acquired",
    ]),
    updatedAt: z.string().datetime({ offset: true }),
    acceptedTaskCount: z.number().int().nonnegative(),
    notice: nonEmptyStringSchema,
    candidates: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
            repositoryUrl: z.string().url(),
            primaryLicenseUrl: z.string().url(),
            licenseName: nonEmptyStringSchema,
            ecosystem: z.literal("typescript-javascript"),
            screeningStatus: z.enum(["task-not-selected", "tasks-acquired"]),
            taskIds: z.array(nonEmptyStringSchema),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((inventory, context) => {
    const acquiredTaskCount = inventory.candidates.reduce(
      (total, candidate) => total + candidate.taskIds.length,
      0,
    );
    if (inventory.acceptedTaskCount !== acquiredTaskCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "acceptedTaskCount must equal the number of acquired task ids.",
        path: ["acceptedTaskCount"],
      });
    }
  });

const corpusGateBaseSchema = z.object({
  schemaVersion: z.literal("workflow-corpus-residual-gate-v1"),
  phase: z.literal("sacrificial-development-tasks"),
  requiredAcceptedTaskCount: z.number().int().min(3).max(5),
  acceptedTaskCount: z.number().int().nonnegative(),
  acceptedTaskIds: z.array(nonEmptyStringSchema),
  candidateInventoryPath: relativePathSchema,
  nextAction: nonEmptyStringSchema,
});

export const workflowCorpusResidualGateSchema = z
  .discriminatedUnion("status", [
    corpusGateBaseSchema.extend({
      status: z.literal("blocked"),
      blockers: z.array(nonEmptyStringSchema).min(1),
    }),
    corpusGateBaseSchema.extend({
      status: z.literal("satisfied"),
      blockers: z.array(nonEmptyStringSchema).length(0),
    }),
  ])
  .superRefine((gate, context) => {
    if (gate.acceptedTaskCount !== gate.acceptedTaskIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "acceptedTaskCount must equal acceptedTaskIds.length.",
        path: ["acceptedTaskCount"],
      });
    }
    if (
      gate.status === "blocked" &&
      gate.acceptedTaskCount >= gate.requiredAcceptedTaskCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A blocked residual gate must remain below its required count.",
        path: ["acceptedTaskCount"],
      });
    }
    if (
      gate.status === "satisfied" &&
      gate.acceptedTaskCount < gate.requiredAcceptedTaskCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A satisfied gate must meet its required task count.",
        path: ["acceptedTaskCount"],
      });
    }
  });

export const workflowTaskFamilyAssignmentSchema = z
  .object({
    taskId: nonEmptyStringSchema,
    split: workflowCorpusSplitSchema,
    repository: nonEmptyStringSchema,
    subsystem: nonEmptyStringSchema,
    rootCause: nonEmptyStringSchema,
    validator: nonEmptyStringSchema,
    ancestryGroup: nonEmptyStringSchema,
  })
  .strict();

export const workflowCorpusManifestSchema = z
  .object({
    schemaVersion: z.literal("workflow-corpus-manifest-v1"),
    corpusId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    purpose: z.enum(["sacrificial-development", "heldout-evaluation"]),
    sealClass: z.enum(["exploratory", "confirmatory"]),
    status: z.enum(["draft", "sealed"]),
    ecosystem: z.literal("typescript-javascript"),
    createdAt: z.string().datetime({ offset: true }),
    sealedAt: z.string().datetime({ offset: true }).nullable(),
    taskFamilySplitMethod: nonEmptyStringSchema,
    taskFamilyIndex: z.array(workflowTaskFamilyAssignmentSchema),
    tasks: z.array(workflowCorpusTaskSchema),
    exclusions: z.array(workflowCorpusExclusionSchema),
    corpusReviews: z
      .array(
        z
          .object({
            kind: z.enum(["deduplication"]),
            path: relativePathSchema,
            digest: sha256Schema,
          })
          .strict(),
      )
      .max(1),
    residualGatePath: relativePathSchema.nullable(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.status === "sealed" && manifest.sealedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A sealed manifest requires sealedAt.",
        path: ["sealedAt"],
      });
    }
    if (manifest.status === "draft" && manifest.residualGatePath === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A draft manifest requires an explicit residual gate.",
        path: ["residualGatePath"],
      });
    }
    if (manifest.status === "sealed" && manifest.residualGatePath !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A sealed manifest may not retain a blocked residual gate.",
        path: ["residualGatePath"],
      });
    }
    if (
      manifest.purpose === "sacrificial-development" &&
      manifest.tasks.some(({ split }) => split === "heldout")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Sacrificial development tasks must use train/dev splits.",
        path: ["tasks"],
      });
    }
    if (
      manifest.purpose === "heldout-evaluation" &&
      manifest.tasks.some(({ split }) => split !== "heldout")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Held-out evaluation tasks must use the heldout split.",
        path: ["tasks"],
      });
    }
    const familyAssignments = new Map<
      string,
      (typeof manifest.taskFamilyIndex)[number]
    >();
    const familySplits = new Map<string, string>();
    for (const assignment of manifest.taskFamilyIndex) {
      if (familyAssignments.has(assignment.taskId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate task-family assignment: ${assignment.taskId}`,
          path: ["taskFamilyIndex"],
        });
      }
      familyAssignments.set(assignment.taskId, assignment);
      const dimensions = {
        repository: assignment.repository,
        subsystem: assignment.subsystem,
        rootCause: assignment.rootCause,
        validator: assignment.validator,
        ancestryGroup: assignment.ancestryGroup,
      };
      for (const [dimension, value] of Object.entries(dimensions)) {
        const familyKey = `${dimension}\u0000${value}`;
        const previousSplit = familySplits.get(familyKey);
        if (previousSplit !== undefined && previousSplit !== assignment.split) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${dimension} family crosses ${previousSplit}/${assignment.split}: ${assignment.taskId}`,
            path: ["taskFamilyIndex"],
          });
        }
        familySplits.set(familyKey, assignment.split);
      }
    }
    for (const task of manifest.tasks) {
      const assignment = familyAssignments.get(task.id);
      if (
        assignment === undefined ||
        assignment.split !== task.split ||
        assignment.repository !== task.family.repository ||
        assignment.subsystem !== task.family.subsystem ||
        assignment.rootCause !== task.family.rootCause ||
        assignment.validator !== task.family.validator ||
        assignment.ancestryGroup !== task.family.ancestryGroup
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Task ${task.id} requires an exact entry in taskFamilyIndex.`,
          path: ["taskFamilyIndex"],
        });
      }
    }
    if (manifest.sealClass === "confirmatory") {
      if (
        manifest.purpose !== "heldout-evaluation" ||
        manifest.tasks.length < 30
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "A confirmatory seal requires at least 30 held-out evaluation tasks.",
          path: ["sealClass"],
        });
      }
      const indexedSplits = new Set(
        manifest.taskFamilyIndex.map(({ split }) => split),
      );
      for (const split of workflowCorpusSplitSchema.options) {
        if (!indexedSplits.has(split)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "A confirmatory family index must cover train, dev, and heldout.",
            path: ["taskFamilyIndex"],
          });
          break;
        }
      }
    }
  });

export const workflowCorpusSealSchema = z
  .object({
    schemaVersion: z.literal("workflow-corpus-seal-v1"),
    corpusId: nonEmptyStringSchema,
    sealClass: z.enum(["exploratory", "confirmatory"]),
    readyForConfirmatoryRun: z.boolean(),
    manifestDigest: sha256Schema,
    corpusDigest: sha256Schema,
    sealedAt: z.string().datetime({ offset: true }),
    taskDigests: z.array(
      z
        .object({
          taskId: nonEmptyStringSchema,
          digest: sha256Schema,
        })
        .strict(),
    ),
    evidenceDigests: z.array(
      z
        .object({
          path: relativePathSchema,
          digest: sha256Schema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((seal, context) => {
    if (seal.readyForConfirmatoryRun !== (seal.sealClass === "confirmatory")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "readyForConfirmatoryRun is true only for a confirmatory corpus seal.",
        path: ["readyForConfirmatoryRun"],
      });
    }
  });

export type WorkflowCorpusTask = z.infer<typeof workflowCorpusTaskSchema>;
export type WorkflowCorpusManifest = z.infer<
  typeof workflowCorpusManifestSchema
>;
export type WorkflowCorpusSeal = z.infer<typeof workflowCorpusSealSchema>;

export interface RepositoryTaskSpec {
  schemaVersion: "workflow-repository-task-v1";
  taskId: string;
  snapshotDirectory: string;
  snapshotDigest: string;
  taskRequest: string;
  setupCommand: RepositoryTaskCommand;
  visibleChecks: RepositoryTaskCommand[];
  hiddenValidator: RepositoryTaskCommand;
  hiddenValidatorSourcePath: string;
  hiddenValidatorSourceDigest: string;
  offlineDependencyCache: {
    directory: string;
    digest: string;
    mountPath: "/workflow-cache";
    setupWritablePaths: string[];
  } | null;
  allowedPaths: string[];
  prohibitedPaths: string[];
  limits: {
    wallClockMs: number;
    commandTimeoutMs: number;
    memoryBytes: number;
    diskBytes: number;
    pids: number;
    cpus: number;
    maxCommands: number;
    maxTurns: number;
  };
  provenance: {
    sourceRepository: string;
    sourceCommit: string;
    licenseSpdx: string;
    acquisitionDigest: string;
    validatorDigest: string;
    familyId: string;
    split: WorkflowCorpusTask["split"];
  };
}

interface RepositoryTaskCommand {
  argv: string[];
  cwd: ".";
  env: Record<string, string>;
  timeoutMs: number;
}

export function toRepositoryTaskSpec(
  task: WorkflowCorpusTask,
): RepositoryTaskSpec {
  const commandTimeoutMs = task.limits.runtimeSeconds * 1000;
  const command = (argv: string[]): RepositoryTaskCommand => ({
    argv,
    cwd: ".",
    env: {},
    timeoutMs: commandTimeoutMs,
  });
  return {
    schemaVersion: "workflow-repository-task-v1",
    taskId: task.id,
    snapshotDirectory: task.snapshotDirectory,
    snapshotDigest: task.snapshotDigest,
    taskRequest: task.taskRequest,
    setupCommand: command(task.setupCommand),
    visibleChecks: task.visibleChecks.map(({ command: argv }) => command(argv)),
    hiddenValidator: command(task.hiddenValidator.command),
    hiddenValidatorSourcePath: task.hiddenValidator.sourcePath,
    hiddenValidatorSourceDigest: task.hiddenValidator.sourceDigest,
    offlineDependencyCache: {
      directory: resolve(task.offlineDependencies.cachePath),
      digest: task.offlineDependencies.cacheDigest,
      mountPath: "/workflow-cache",
      setupWritablePaths: task.offlineDependencies.setupWritablePaths,
    },
    allowedPaths: task.allowedPaths,
    prohibitedPaths: task.prohibitedPaths,
    limits: {
      wallClockMs: commandTimeoutMs,
      commandTimeoutMs,
      memoryBytes: task.limits.memoryMegabytes * 1024 * 1024,
      diskBytes: task.limits.diskMegabytes * 1024 * 1024,
      pids: task.limits.maxProcesses,
      cpus: task.limits.cpus,
      maxCommands: task.limits.maxCommands,
      maxTurns: task.limits.maxTurns,
    },
    provenance: {
      sourceRepository: task.provenance.repositoryUrl,
      sourceCommit: task.provenance.sourceCommit,
      licenseSpdx: task.provenance.licenseSpdx,
      acquisitionDigest: fingerprint({
        snapshotDigest: task.snapshotDigest,
        sourceArchiveDigest: task.provenance.sourceArchiveDigest,
        upstreamPatchDigest: task.provenance.upstreamPatchDigest,
      }),
      validatorDigest: task.hiddenValidator.sourceDigest,
      familyId: fingerprint(task.family),
      split: task.split,
    },
  };
}
