import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = process.env.WORKFLOW_TASK_WORKSPACE;
if (!target) {
  throw new Error("WORKFLOW_TASK_WORKSPACE is required.");
}

const source = resolve(
  ".cache/workflow-value/tasks/qs-empty-array-cycle/pristine",
);
await rm(target, { recursive: true, force: true });
await cp(source, target, {
  recursive: true,
  force: true,
  preserveTimestamps: true,
});
