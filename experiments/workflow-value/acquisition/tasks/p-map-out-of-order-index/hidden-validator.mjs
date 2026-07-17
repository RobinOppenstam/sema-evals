import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace =
  process.env.WORKFLOW_TASK_WORKSPACE ?? process.argv[2] ?? process.cwd();
const { pMapIterable } = await import(
  pathToFileURL(resolve(workspace, "index.js")).href
);
const delayed = (milliseconds, value) =>
  new Promise((resolvePromise) => {
    setTimeout(() => resolvePromise(value), milliseconds);
  });
const input = [delayed(40, "a"), delayed(5, "b"), delayed(20, "c")];
const result = [];
for await (const entry of pMapIterable(
  input,
  async (value, index) => [value, index],
  { concurrency: 3 },
)) {
  result.push(entry);
}

assert.deepEqual(result, [
  ["a", 0],
  ["b", 1],
  ["c", 2],
]);
