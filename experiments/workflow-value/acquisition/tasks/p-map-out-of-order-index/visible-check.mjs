import assert from "node:assert/strict";

import { pMapIterable } from "../index.js";

const result = [];
for await (const entry of pMapIterable(
  ["a", "b", "c"],
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
