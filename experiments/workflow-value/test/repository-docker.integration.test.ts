import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  AgentWorkflowRunner,
  DeterministicWritableHarnessAdapter,
  DockerSandboxDriver,
  runProcess,
  sha256,
} from "@sema-evals/workflow-runner";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

import {
  toRepositoryTaskSpec,
  workflowCorpusManifestSchema,
} from "../src/corpus-schemas.js";
import { runRepositoryWorkflowTrial } from "../src/repository-experiment.js";

const enabled = process.env["WORKFLOW_RUNNER_DOCKER_TEST"] === "1";
const suite = enabled ? describe : describe.skip;

suite("repository workflow-value Docker instrumentation", () => {
  test("runs the sealed qs cumulative task through setup, edit, visible checks, and scorer-only validation", async () => {
    const manifestPath = resolve(
      "experiments/workflow-value/datasets/manifests/sacrificial-development.yaml",
    );
    const manifest = workflowCorpusManifestSchema.parse(
      YAML.parse(await readFile(manifestPath, "utf8")),
    );
    const corpusTask = manifest.tasks.find(
      ({ id }) => id === "qs-cumulative-array-limit",
    );
    if (!corpusTask) {
      throw new Error("Missing qs cumulative sacrificial task.");
    }
    const task = toRepositoryTaskSpec(corpusTask);
    const postFixRoot = resolve(
      ".cache/workflow-value/tasks/qs-cumulative-array-limit/post-fix",
    );
    const [parseSource, utilsSource] = await Promise.all([
      readFile(resolve(postFixRoot, "lib/parse.js"), "utf8"),
      readFile(resolve(postFixRoot, "lib/utils.js"), "utf8"),
    ]);
    const editScript = [
      "const fs=require('fs');",
      `fs.writeFileSync('lib/parse.js',${JSON.stringify(parseSource)});`,
      `fs.writeFileSync('lib/utils.js',${JSON.stringify(utilsSource)});`,
    ].join("");
    const image =
      process.env["WORKFLOW_RUNNER_IMAGE"] ??
      "sema-evals/workflow-runner-conformance:node22";
    const inspect = await runProcess(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", image],
      { timeoutMs: 10_000 },
    );
    expect(inspect.exitCode).toBe(0);
    const seccompProfile = resolve(
      "packages/workflow-runner/docker/seccomp-conformance.json",
    );
    const driver = new DockerSandboxDriver({
      runnerImage: image,
      expectedImageDigest: inspect.stdout.trim(),
      seccompProfile,
      seccompProfileDigest: sha256(await readFile(seccompProfile)),
      network: { mode: "none" },
      auditedStateAllowlist: {
        home: [],
        tmp: ["node-compile-cache"],
      },
    });
    const harness = new DeterministicWritableHarnessAdapter([
      {
        command: {
          argv: ["node", "-e", editScript],
          cwd: ".",
          env: {},
          timeoutMs: 30_000,
        },
        cumulativeModelTokens: null,
      },
    ]);
    const result = await runRepositoryWorkflowTrial({
      task,
      condition: "equal-library-prose",
      harness,
      runner: new AgentWorkflowRunner(driver),
      referenceProvider: new FixtureReferenceProvider(),
      datasetDigest:
        "25b8b406c9e1fa38a1ead22b8e8c8b747714fba9b4933ab9b5c5929480994265",
      scorerFingerprint: sha256("qs-cumulative-hidden-validator-v1"),
      vocabularyRoot: "",
    });
    expect(result.executionStatus).toBe("runner-completed");
    expect(result.successWithinBudget).toBe(true);
    expect(result.runnerResult?.visibleValidatorPassed).toBe(true);
    expect(result.runnerResult?.hiddenValidatorPassed).toBe(true);
    expect(result.runnerResult?.changedPaths).toEqual([
      "lib/parse.js",
      "lib/utils.js",
    ]);
    expect(result.delivery.contextPayloadBytes).toBeGreaterThan(0);
    expect(result.delivery.hydrationBytes).toBe(0);
  }, 180_000);
});
