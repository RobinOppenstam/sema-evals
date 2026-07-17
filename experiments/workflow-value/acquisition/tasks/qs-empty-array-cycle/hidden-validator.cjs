"use strict";

const assert = require("node:assert/strict");
const { resolve } = require("node:path");

const workspace =
  process.env.WORKFLOW_TASK_WORKSPACE || process.argv[2] || process.cwd();
const qs = require(resolve(workspace, "lib"));

const withKey = [];
withKey.extra = "x";
assert.equal(
  qs.stringify({ a: withKey }, { allowEmptyArrays: true }),
  "a%5Bextra%5D=x",
);

const container = {};
const cyclic = [];
cyclic.back = container;
container.a = cyclic;
assert.throws(
  () => qs.stringify(container, { allowEmptyArrays: true }),
  RangeError,
);
