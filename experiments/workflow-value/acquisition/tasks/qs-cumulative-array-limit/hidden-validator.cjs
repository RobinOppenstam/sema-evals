"use strict";

const assert = require("node:assert/strict");
const { resolve } = require("node:path");

const workspace =
  process.env.WORKFLOW_TASK_WORKSPACE || process.argv[2] || process.cwd();
const qs = require(resolve(workspace, "lib"));
const options = {
  arrayLimit: 5,
  comma: true,
  throwOnLimitExceeded: true,
};

assert.throws(
  () => qs.parse("a=1,2,3&a=4,5,6", options),
  new RangeError("Array limit exceeded. Only 5 elements allowed in an array."),
);
assert.throws(
  () =>
    qs.parse("a[0]=1&a[1]=2&a=3", {
      arrayLimit: 1,
      throwOnLimitExceeded: true,
    }),
  new RangeError("Array limit exceeded. Only 1 element allowed in an array."),
);
assert.deepEqual(qs.parse("a=1,2,3&a=4", options), {
  a: ["1", "2", "3", "4"],
});
