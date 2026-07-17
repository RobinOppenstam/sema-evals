import { readFile } from "node:fs/promises";

import { sha256Text } from "@sema-evals/core";
import { parse } from "yaml";

import {
  workflowFixtureSetSchema,
  type WorkflowDatasetGate,
  type WorkflowFixtureSet,
} from "./schemas.js";

export interface LoadedWorkflowFixtures {
  fixtureDigest: string;
  fixtureSet: WorkflowFixtureSet;
  devTaskCount: number;
  evalTaskCount: number;
}

export function evaluateDatasetAcquisitionGate(
  fixtureSet: WorkflowFixtureSet,
): WorkflowDatasetGate {
  const dataset = fixtureSet.dataset;
  if (dataset.status === "seed-only") {
    return {
      datasetLabel: dataset.label,
      status: dataset.status,
      readyForModelPilot: false,
      requirement: dataset.acquisitionRequirement,
    };
  }
  return {
    datasetLabel: dataset.label,
    status: dataset.status,
    readyForModelPilot: true,
    requirement: dataset.acquisitionRequirement,
    license: dataset.license,
    acquiredAt: dataset.acquiredAt,
    corpusDigest: dataset.corpusDigest,
    taskFamilySplitMethod: dataset.taskFamilySplitMethod,
    deduplicationReport: dataset.deduplicationReport,
    leakageReview: dataset.leakageReview,
    validatorReview: dataset.validatorReview,
  };
}

export function assertDatasetReadyForModelPilot(
  fixtureSet: WorkflowFixtureSet,
): void {
  const gate = evaluateDatasetAcquisitionGate(fixtureSet);
  if (!gate.readyForModelPilot) {
    throw new Error(
      `Workflow-value model pilot blocked: dataset ${gate.datasetLabel} is ${gate.status}. ${gate.requirement}`,
    );
  }
}

export async function loadFixtureFile(
  path: string,
): Promise<LoadedWorkflowFixtures> {
  const raw = await readFile(path, "utf8");
  const fixtureSet = workflowFixtureSetSchema.parse(parse(raw));
  const ids = new Set<string>();
  for (const task of fixtureSet.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate workflow task id: ${task.id}.`);
    }
    ids.add(task.id);
  }
  const devTaskCount = fixtureSet.tasks.filter(
    (task) => task.split === "dev",
  ).length;
  const evalTaskCount = fixtureSet.tasks.filter(
    (task) => task.split === "eval",
  ).length;
  if (devTaskCount === 0 || evalTaskCount === 0) {
    throw new Error("Workflow fixtures require non-empty dev and eval splits.");
  }
  return {
    fixtureDigest: sha256Text(raw),
    fixtureSet,
    devTaskCount,
    evalTaskCount,
  };
}
