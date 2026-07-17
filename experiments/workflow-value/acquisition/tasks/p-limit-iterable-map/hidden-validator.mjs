import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace =
  process.env.WORKFLOW_TASK_WORKSPACE ?? process.argv[2] ?? process.cwd();
const { default: pLimit } = await import(
  pathToFileURL(resolve(workspace, "index.js")).href
);
const limit = pLimit(2);

assert.deepEqual(
  await limit.map(new Set([1, 2, 3, 4]), async (value, index) => [
    value * 2,
    index,
  ]),
  [
    [2, 0],
    [4, 1],
    [6, 2],
    [8, 3],
  ],
);

const customIterable = {
  *[Symbol.iterator]() {
    yield "a";
    yield "b";
    yield "c";
  },
};
assert.deepEqual(
  await limit.map(customIterable, async (value, index) => `${index}:${value}`),
  ["0:a", "1:b", "2:c"],
);
