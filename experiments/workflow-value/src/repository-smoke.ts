import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  AgentWorkflowRunner,
  DeterministicWritableHarnessAdapter,
  DockerSandboxDriver,
  runProcess,
  sha256,
} from "@sema-evals/workflow-runner";
import YAML from "yaml";

import {
  toRepositoryTaskSpec,
  workflowCorpusManifestSchema,
  workflowCorpusSealSchema,
} from "./corpus-schemas.js";
import {
  repositoryWorkflowConditionSchema,
  runRepositoryWorkflowTrial,
  type RepositoryWorkflowCondition,
} from "./repository-experiment.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface Options {
  taskId: string;
  condition: RepositoryWorkflowCondition;
  image: string;
  output: string;
}

function parseArgs(args: readonly string[]): Options {
  const options: Options = {
    taskId: "qs-cumulative-array-limit",
    condition: "equal-library-prose",
    image:
      process.env.WORKFLOW_RUNNER_IMAGE ??
      "sema-evals/workflow-runner-conformance:node22",
    output: resolve(
      process.env.WORKFLOW_REPOSITORY_SMOKE_OUTPUT ??
        "/tmp/workflow-repository-smoke.json",
    ),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--task") {
      options.taskId = args[++index] ?? "";
      continue;
    }
    if (argument === "--condition") {
      options.condition = repositoryWorkflowConditionSchema.parse(
        args[++index],
      );
      continue;
    }
    if (argument === "--image") {
      options.image = args[++index] ?? "";
      continue;
    }
    if (argument === "--output") {
      options.output = resolve(args[++index] ?? "");
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function runRepositorySmoke(
  args: readonly string[],
): Promise<string> {
  const options = parseArgs(args);
  const manifest = workflowCorpusManifestSchema.parse(
    YAML.parse(
      await readFile(
        resolve(
          repositoryRoot,
          "experiments/workflow-value/datasets/manifests/sacrificial-development.yaml",
        ),
        "utf8",
      ),
    ),
  );
  const seal = workflowCorpusSealSchema.parse(
    JSON.parse(
      await readFile(
        resolve(
          repositoryRoot,
          "experiments/workflow-value/datasets/seals/sacrificial-development.json",
        ),
        "utf8",
      ),
    ),
  );
  const corpusTask = manifest.tasks.find(({ id }) => id === options.taskId);
  if (!corpusTask) {
    throw new Error(`Unknown sacrificial task: ${options.taskId}`);
  }
  const projectedTask = toRepositoryTaskSpec(corpusTask);
  const task = {
    ...projectedTask,
    snapshotDirectory: resolve(repositoryRoot, projectedTask.snapshotDirectory),
    hiddenValidatorSourcePath: resolve(
      repositoryRoot,
      projectedTask.hiddenValidatorSourcePath,
    ),
    offlineDependencyCache: projectedTask.offlineDependencyCache
      ? {
          ...projectedTask.offlineDependencyCache,
          directory: resolve(
            repositoryRoot,
            corpusTask.offlineDependencies.cachePath,
          ),
        }
      : null,
  };
  const postFixRoot = resolve(
    repositoryRoot,
    `.cache/workflow-value/tasks/${options.taskId}/post-fix`,
  );
  const writes = await Promise.all(
    task.allowedPaths.map(async (path) => ({
      path,
      contents: await readFile(join(postFixRoot, path), "utf8"),
    })),
  );
  const editScript = [
    "const fs=require('fs');",
    ...writes.map(
      ({ path, contents }) =>
        `fs.writeFileSync(${JSON.stringify(path)},${JSON.stringify(contents)});`,
    ),
  ].join("");
  const inspect = await runProcess(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", options.image],
    { timeoutMs: 10_000 },
  );
  if (inspect.exitCode !== 0) {
    throw new Error(
      `Deterministic conformance image unavailable: ${inspect.stderr}`,
    );
  }
  const seccompProfile = resolve(
    repositoryRoot,
    "packages/workflow-runner/docker/seccomp-conformance.json",
  );
  const driver = new DockerSandboxDriver({
    runnerImage: options.image,
    expectedImageDigest: inspect.stdout.trim(),
    seccompProfile,
    seccompProfileDigest: sha256(await readFile(seccompProfile)),
    network: { mode: "none" },
    auditedStateAllowlist: {
      home: [],
      tmp: ["node-compile-cache"],
    },
  });
  const result = await runRepositoryWorkflowTrial({
    task,
    condition: options.condition,
    harness: new DeterministicWritableHarnessAdapter([
      {
        command: {
          argv: ["node", "-e", editScript],
          cwd: ".",
          env: {},
          timeoutMs: task.limits.commandTimeoutMs,
        },
        cumulativeModelTokens: null,
      },
    ]),
    runner: new AgentWorkflowRunner(driver),
    referenceProvider: new FixtureReferenceProvider(),
    datasetDigest: seal.corpusDigest,
    scorerFingerprint: task.hiddenValidatorSourceDigest,
    vocabularyRoot: "",
  });
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    "Deterministic repository instrumentation completed; this is runner/mechanism evidence, not model-performance evidence.",
  );
  console.log(`Task: ${task.taskId}`);
  console.log(`Condition: ${options.condition}`);
  console.log(
    `Status: ${result.runnerResult?.status ?? result.executionStatus}`,
  );
  console.log(`Output: ${options.output}`);
  return options.output;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runRepositorySmoke(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
