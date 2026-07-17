"use strict";

const assert = require("node:assert/strict");
const qs = require("../lib");

assert.equal(qs.stringify({ a: [] }, { allowEmptyArrays: true }), "a[]");
