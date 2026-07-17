import assert from "node:assert/strict";

import pLimit from "../index.js";

const limit = pLimit(2);
assert.deepEqual(
  await limit.map([1, 2, 3], async (value, index) => value + index),
  [1, 3, 5],
);
