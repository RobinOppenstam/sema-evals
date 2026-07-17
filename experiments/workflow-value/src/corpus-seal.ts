import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { fingerprint, sha256Text, stableJson } from "@sema-evals/core";
import YAML from "yaml";

import {
  type WorkflowCorpusManifest,
  type WorkflowCorpusSeal,
  workflowAcquisitionReviewSchema,
  workflowContaminationReviewSchema,
  workflowCorpusManifestSchema,
  workflowCorpusSealSchema,
  workflowDeduplicationReportSchema,
  workflowLeakageReviewSchema,
  workflowLicenseReviewSchema,
  workflowTaskFamilyReviewSchema,
  workflowValidatorReviewSchema,
} from "./corpus-schemas.js";

interface SealOptions {
  manifestPath: string;
  evidenceRoot?: string;
}

function resolveEvidencePath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  if (
    absolutePath !== absoluteRoot &&
    !absolutePath.startsWith(`${absoluteRoot}${sep}`)
  ) {
    throw new Error(`Evidence path escapes the evidence root: ${path}`);
  }
  return absolutePath;
}

async function sha256File(path: string): Promise<string> {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

export async function fingerprintDirectory(path: string): Promise<string> {
  const entries: Array<{
    path: string;
    kind: "directory" | "file";
    mode: number;
    digest: string | null;
  }> = [];

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const pathFromRoot = relative(path, absolutePath).split(sep).join("/");
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Corpus evidence directories may not contain symlinks: ${pathFromRoot}`,
        );
      }
      if (metadata.isDirectory()) {
        entries.push({
          path: pathFromRoot,
          kind: "directory",
          mode: metadata.mode & 0o777,
          digest: null,
        });
        await visit(absolutePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Unsupported corpus evidence entry: ${pathFromRoot}`);
      }
      entries.push({
        path: pathFromRoot,
        kind: "file",
        mode: metadata.mode & 0o777,
        digest: await sha256File(absolutePath),
      });
    }
  }

  await visit(resolve(path));
  return fingerprint(entries);
}

async function readStructuredFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  if (path.endsWith(".json")) {
    return JSON.parse(raw) as unknown;
  }
  return YAML.parse(raw) as unknown;
}

async function readManifest(
  manifestPath: string,
): Promise<{ manifest: WorkflowCorpusManifest; raw: string }> {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = manifestPath.endsWith(".json")
    ? (JSON.parse(raw) as unknown)
    : (YAML.parse(raw) as unknown);
  return {
    manifest: workflowCorpusManifestSchema.parse(parsed),
    raw,
  };
}

function validateSealableManifest(manifest: WorkflowCorpusManifest): void {
  if (manifest.status !== "sealed" || manifest.sealedAt === null) {
    throw new Error(
      "Only a completed manifest with status=sealed can be sealed.",
    );
  }
  if (
    manifest.purpose === "sacrificial-development" &&
    (manifest.tasks.length < 3 || manifest.tasks.length > 5)
  ) {
    throw new Error(
      "A sacrificial development corpus requires three to five accepted tasks.",
    );
  }
  if (manifest.purpose === "heldout-evaluation" && manifest.tasks.length < 1) {
    throw new Error("A held-out evaluation corpus requires at least one task.");
  }

  const ids = new Set<string>();
  for (const task of manifest.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate corpus task id: ${task.id}`);
    }
    ids.add(task.id);
  }

  const familySplit = new Map<string, string>();
  for (const task of manifest.tasks) {
    const familyKey = [
      task.family.repository,
      task.family.subsystem,
      task.family.rootCause,
      task.family.validator,
    ].join("\u0000");
    const previousSplit = familySplit.get(familyKey);
    if (previousSplit !== undefined && previousSplit !== task.split) {
      throw new Error(
        `Task family spans splits (${previousSplit}, ${task.split}): ${task.id}`,
      );
    }
    familySplit.set(familyKey, task.split);
  }
}

async function verifyExpectedDigest(
  root: string,
  path: string,
  expectedDigest: string,
  evidence: Map<string, string>,
): Promise<void> {
  const digest = await sha256File(resolveEvidencePath(root, path));
  if (digest !== expectedDigest) {
    throw new Error(
      `Evidence digest mismatch for ${path}: expected ${expectedDigest}, got ${digest}`,
    );
  }
  evidence.set(path, digest);
}

async function verifyExpectedDirectoryDigest(
  root: string,
  path: string,
  expectedDigest: string,
  evidence: Map<string, string>,
): Promise<void> {
  const digest = await fingerprintDirectory(resolveEvidencePath(root, path));
  if (digest !== expectedDigest) {
    throw new Error(
      `Directory digest mismatch for ${path}: expected ${expectedDigest}, got ${digest}`,
    );
  }
  evidence.set(path, digest);
}

async function runEvidenceCommand(
  command: readonly string[],
  options: {
    cwd: string;
    workspace: string;
    timeoutMs: number;
  },
): Promise<void> {
  const [executable, ...arguments_] = command;
  if (executable === undefined) {
    throw new Error("Evidence command may not be empty.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: {
        ...process.env,
        WORKFLOW_TASK_WORKSPACE: options.workspace,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Evidence command timed out after ${options.timeoutMs}ms: ${command.join(" ")}`,
        ),
      );
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            [
              `Evidence command failed with exit ${String(code)}: ${command.join(" ")}`,
              Buffer.concat(stdout).toString("utf8"),
              Buffer.concat(stderr).toString("utf8"),
            ]
              .filter((part) => part.length > 0)
              .join("\n"),
          ),
        );
        return;
      }
      resolvePromise();
    });
  });
}

async function verifyExecutableReset(
  root: string,
  task: WorkflowCorpusManifest["tasks"][number],
): Promise<void> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), `workflow-reset-${task.id}-`),
  );
  const workspace = join(temporaryRoot, "workspace");
  try {
    await runEvidenceCommand(task.resetVerification.materializeCommand, {
      cwd: root,
      workspace,
      timeoutMs: task.limits.runtimeSeconds * 1000,
    });
    if ((await fingerprintDirectory(workspace)) !== task.snapshotDigest) {
      throw new Error(
        `Materialized workspace for ${task.id} does not match its sealed pre-fix snapshot.`,
      );
    }

    await appendFile(
      resolveEvidencePath(workspace, task.resetVerification.mutationProbePath),
      "\nworkflow-corpus-reset-probe\n",
      "utf8",
    );
    if ((await fingerprintDirectory(workspace)) === task.snapshotDigest) {
      throw new Error(`Mutation probe did not change workspace ${task.id}.`);
    }

    await runEvidenceCommand(task.resetVerification.resetCommand, {
      cwd: root,
      workspace,
      timeoutMs: task.limits.runtimeSeconds * 1000,
    });
    if ((await fingerprintDirectory(workspace)) !== task.snapshotDigest) {
      throw new Error(
        `Executable reset for ${task.id} did not restore the pre-fix snapshot digest.`,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function assertReviewField(
  actual: string | number,
  expected: string | number,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${label} does not match the accepted task: expected ${String(expected)}, got ${String(actual)}.`,
    );
  }
}

function validateTaskReview(
  kind: WorkflowCorpusManifest["tasks"][number]["reviewDocuments"][number]["kind"],
  value: unknown,
  task: WorkflowCorpusManifest["tasks"][number],
): {
  taskId: string;
  status: "pending" | "pass" | "fail";
  reviewer: string;
} {
  if (kind === "license") {
    const review = workflowLicenseReviewSchema.parse(value);
    assertReviewField(
      review.licenseName,
      task.provenance.licenseName,
      "License name",
    );
    if (review.spdxId === null) {
      throw new Error(`License review for ${task.id} requires an SPDX id.`);
    }
    assertReviewField(
      review.spdxId,
      task.provenance.licenseSpdx,
      "License SPDX id",
    );
    assertReviewField(
      review.primaryLicenseUrl,
      task.provenance.primaryLicenseUrl,
      "Primary license URL",
    );
    assertReviewField(
      review.redistributionMode,
      task.provenance.redistributionMode,
      "Redistribution mode",
    );
    return review;
  }
  if (kind === "acquisition") {
    const review = workflowAcquisitionReviewSchema.parse(value);
    assertReviewField(
      review.repositoryUrl,
      task.provenance.repositoryUrl,
      "Repository URL",
    );
    assertReviewField(
      review.sourceCommit,
      task.provenance.sourceCommit,
      "Source commit",
    );
    assertReviewField(
      review.upstreamPatchDigest,
      task.provenance.upstreamPatchDigest,
      "Upstream patch digest",
    );
    assertReviewField(
      review.preFixSnapshotDigest,
      task.snapshotDigest,
      "Pre-fix snapshot digest",
    );
    assertReviewField(
      review.postFixSnapshotDigest,
      task.postFixSnapshotDigest,
      "Post-fix snapshot digest",
    );
    assertReviewField(
      review.resetProofDigest,
      task.resetProofDigest,
      "Reset proof digest",
    );
    return review;
  }
  if (kind === "validator") {
    const review = workflowValidatorReviewSchema.parse(value);
    assertReviewField(
      review.hiddenValidatorPath,
      task.hiddenValidator.sourcePath,
      "Hidden validator path",
    );
    assertReviewField(
      review.hiddenValidatorDigest,
      task.hiddenValidator.sourceDigest,
      "Hidden validator digest",
    );
    assertReviewField(
      review.preFixExitCode,
      task.hiddenValidator.expectedPreFixExitCode,
      "Pre-fix validator exit code",
    );
    assertReviewField(
      review.postFixExitCode,
      task.hiddenValidator.expectedPostFixExitCode,
      "Post-fix validator exit code",
    );
    const reviewedVisibleChecks = new Set(
      review.visibleChecks.map(({ name }) => name),
    );
    for (const check of task.visibleChecks) {
      if (!reviewedVisibleChecks.has(check.name)) {
        throw new Error(
          `Validator review for ${task.id} is missing visible check ${check.name}.`,
        );
      }
    }
    return review;
  }
  if (kind === "task-family") {
    const review = workflowTaskFamilyReviewSchema.parse(value);
    assertReviewField(
      review.repositoryFamily,
      task.family.repository,
      "Repository family",
    );
    assertReviewField(
      review.subsystemFamily,
      task.family.subsystem,
      "Subsystem family",
    );
    assertReviewField(
      review.rootCauseFamily,
      task.family.rootCause,
      "Root-cause family",
    );
    assertReviewField(
      review.validatorFamily,
      task.family.validator,
      "Validator family",
    );
    assertReviewField(
      review.ancestryGroup,
      task.family.ancestryGroup,
      "Ancestry group",
    );
    assertReviewField(review.assignedSplit, task.split, "Assigned split");
    return review;
  }
  if (kind === "contamination") {
    const review = workflowContaminationReviewSchema.parse(value);
    assertReviewField(
      review.upstreamPatchMergedAt,
      task.provenance.upstreamPatchMergedAt,
      "Upstream patch merge timestamp",
    );
    return review;
  }
  return workflowLeakageReviewSchema.parse(value);
}

export async function buildCorpusSeal(
  options: SealOptions,
): Promise<WorkflowCorpusSeal> {
  const manifestPath = resolve(options.manifestPath);
  const evidenceRoot = resolve(options.evidenceRoot ?? process.cwd());
  const { manifest, raw } = await readManifest(manifestPath);
  validateSealableManifest(manifest);

  const evidence = new Map<string, string>();
  for (const task of manifest.tasks) {
    let acquisitionReviewer: string | undefined;
    let validatorReviewer: string | undefined;
    for (const reference of task.reviewDocuments) {
      await verifyExpectedDigest(
        evidenceRoot,
        reference.path,
        reference.digest,
        evidence,
      );
      const review = validateTaskReview(
        reference.kind,
        await readStructuredFile(
          resolveEvidencePath(evidenceRoot, reference.path),
        ),
        task,
      );
      if (review.taskId !== task.id || review.status !== "pass") {
        throw new Error(
          `Review ${reference.path} must pass and target task ${task.id}.`,
        );
      }
      if (reference.kind === "acquisition") {
        acquisitionReviewer = review.reviewer;
      }
      if (reference.kind === "validator") {
        validatorReviewer = review.reviewer;
      }
    }
    if (
      acquisitionReviewer === undefined ||
      validatorReviewer === undefined ||
      acquisitionReviewer.toLocaleLowerCase() ===
        validatorReviewer.toLocaleLowerCase()
    ) {
      throw new Error(
        `Task ${task.id} requires different acquisition and validator reviewers.`,
      );
    }

    await verifyExpectedDirectoryDigest(
      evidenceRoot,
      task.snapshotDirectory,
      task.snapshotDigest,
      evidence,
    );
    for (const reference of task.resetVerification.evidenceFiles) {
      await verifyExpectedDigest(
        evidenceRoot,
        reference.path,
        reference.digest,
        evidence,
      );
    }
    await verifyExecutableReset(evidenceRoot, task);
    if (task.resetProofDigest !== task.snapshotDigest) {
      throw new Error(
        `Recorded reset proof for ${task.id} does not match the executable reset digest.`,
      );
    }
    await verifyExpectedDigest(
      evidenceRoot,
      task.hiddenValidator.sourcePath,
      task.hiddenValidator.sourceDigest,
      evidence,
    );
    await verifyExpectedDigest(
      evidenceRoot,
      task.offlineDependencies.lockfilePath,
      task.offlineDependencies.lockfileDigest,
      evidence,
    );
    await verifyExpectedDirectoryDigest(
      evidenceRoot,
      task.offlineDependencies.cachePath,
      task.offlineDependencies.cacheDigest,
      evidence,
    );

    const acquisitionInstructionsPath =
      task.provenance.acquisitionInstructionsPath;
    evidence.set(
      acquisitionInstructionsPath,
      await sha256File(
        resolveEvidencePath(evidenceRoot, acquisitionInstructionsPath),
      ),
    );
  }

  for (const reference of manifest.corpusReviews) {
    await verifyExpectedDigest(
      evidenceRoot,
      reference.path,
      reference.digest,
      evidence,
    );
    const report = workflowDeduplicationReportSchema.parse(
      await readStructuredFile(
        resolveEvidencePath(evidenceRoot, reference.path),
      ),
    );
    if (report.corpusId !== manifest.corpusId || report.status !== "pass") {
      throw new Error(
        `Corpus review ${reference.path} must pass and target ${manifest.corpusId}.`,
      );
    }
  }

  const taskDigests = manifest.tasks
    .map((task) => ({
      taskId: task.id,
      digest: fingerprint(task),
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  const evidenceDigests = [...evidence.entries()]
    .map(([path, digest]) => ({ path, digest }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifestDigest = sha256Text(raw);
  const corpusDigest = fingerprint({
    manifestDigest,
    taskDigests,
    evidenceDigests,
  });

  return workflowCorpusSealSchema.parse({
    schemaVersion: "workflow-corpus-seal-v1",
    corpusId: manifest.corpusId,
    sealClass: manifest.sealClass,
    readyForConfirmatoryRun: manifest.sealClass === "confirmatory",
    manifestDigest,
    corpusDigest,
    sealedAt: manifest.sealedAt,
    taskDigests,
    evidenceDigests,
  });
}

export async function verifyCorpusSeal(
  options: SealOptions & { sealPath: string },
): Promise<WorkflowCorpusSeal> {
  const expected = workflowCorpusSealSchema.parse(
    await readStructuredFile(resolve(options.sealPath)),
  );
  const actual = await buildCorpusSeal(options);
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error("Corpus seal verification failed.");
  }
  return actual;
}

interface CliArguments {
  manifestPath: string;
  evidenceRoot?: string;
  outputPath?: string;
  verifyPath?: string;
}

function parseCliArguments(argv: readonly string[]): CliArguments {
  let manifestPath: string | undefined;
  let evidenceRoot: string | undefined;
  let outputPath: string | undefined;
  let verifyPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") {
      continue;
    }
    const value = argv[index + 1];
    if (
      flag === "--manifest" ||
      flag === "--root" ||
      flag === "--output" ||
      flag === "--verify"
    ) {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}.`);
      }
      index += 1;
      if (flag === "--manifest") manifestPath = value;
      if (flag === "--root") evidenceRoot = value;
      if (flag === "--output") outputPath = value;
      if (flag === "--verify") verifyPath = value;
      continue;
    }
    throw new Error(`Unknown corpus seal argument: ${flag}`);
  }
  if (manifestPath === undefined) {
    throw new Error("--manifest is required.");
  }
  if (verifyPath === undefined && outputPath === undefined) {
    throw new Error(
      "Provide --output to write a seal or --verify to check one.",
    );
  }
  if (verifyPath !== undefined && outputPath !== undefined) {
    throw new Error("--output and --verify are mutually exclusive.");
  }
  const parsed: CliArguments = { manifestPath };
  if (evidenceRoot !== undefined) parsed.evidenceRoot = evidenceRoot;
  if (outputPath !== undefined) parsed.outputPath = outputPath;
  if (verifyPath !== undefined) parsed.verifyPath = verifyPath;
  return parsed;
}

export async function runCorpusSealCli(argv: readonly string[]): Promise<void> {
  const arguments_ = parseCliArguments(argv);
  if (arguments_.verifyPath !== undefined) {
    const options: SealOptions & { sealPath: string } = {
      manifestPath: arguments_.manifestPath,
      sealPath: arguments_.verifyPath,
    };
    if (arguments_.evidenceRoot !== undefined) {
      options.evidenceRoot = arguments_.evidenceRoot;
    }
    const seal = await verifyCorpusSeal(options);
    process.stdout.write(`${seal.corpusDigest}\n`);
    return;
  }

  const options: SealOptions = {
    manifestPath: arguments_.manifestPath,
  };
  if (arguments_.evidenceRoot !== undefined) {
    options.evidenceRoot = arguments_.evidenceRoot;
  }
  const seal = await buildCorpusSeal(options);
  const outputPath = resolve(arguments_.outputPath!);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(seal, null, 2)}\n`, "utf8");
  process.stdout.write(`${seal.corpusDigest}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1])
) {
  runCorpusSealCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
