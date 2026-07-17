"use strict";

const assert = require("node:assert/strict");
const qs = require("../lib");

assert.throws(
  () =>
    qs.parse("a=x&a=y", {
      arrayLimit: 1,
      throwOnLimitExceeded: true,
    }),
  new RangeError("Array limit exceeded. Only 1 element allowed in an array."),
);
