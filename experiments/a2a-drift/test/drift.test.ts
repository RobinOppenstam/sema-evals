import { fingerprint } from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import {
  assertDriftIsolation,
  buildRequesterRegistry,
  buildWorkerRegistry,
} from "../src/registry.js";
import type { A2aDriftScenario } from "../src/schemas.js";

const BASE_PATTERNS = [
  { handle: "Alpha", definition: { comparator: "<=", threshold: 50 } },
  { handle: "Beta", definition: { comparator: ">=", threshold: 2 } },
  { handle: "Gamma", definition: { asset: "USDC", decimals: 6 } },
];

const DRIFT_SCENARIO: A2aDriftScenario = {
  id: "drift",
  title: "t",
  description: "d",
  task: "task",
  patterns: BASE_PATTERNS,
  acceptanceHandles: ["Alpha", "Beta", "Gamma"],
  drift: {
    handle: "Gamma",
    fieldPath: "asset",
    before: "USDC",
    after: "USDT",
    mutatedDefinition: { asset: "USDT", decimals: 6 },
  },
};

const CLEAN_SCENARIO: A2aDriftScenario = {
  ...DRIFT_SCENARIO,
  id: "clean",
  drift: null,
};

describe("drift injection", () => {
  it("mutates exactly the drifted handle in the worker registry", () => {
    const requester = buildRequesterRegistry(DRIFT_SCENARIO);
    const worker = buildWorkerRegistry(DRIFT_SCENARIO);
    // Drifted handle differs.
    expect(fingerprint(worker.resolve("Gamma"))).not.toBe(
      fingerprint(requester.resolve("Gamma")),
    );
    expect(worker.resolve("Gamma")["asset"]).toBe("USDT");
    // Every other handle is identical.
    for (const handle of ["Alpha", "Beta"]) {
      expect(fingerprint(worker.resolve(handle))).toBe(
        fingerprint(requester.resolve(handle)),
      );
    }
  });

  it("leaves the worker registry identical to the requester's for a no-drift control", () => {
    const requester = buildRequesterRegistry(CLEAN_SCENARIO);
    const worker = buildWorkerRegistry(CLEAN_SCENARIO);
    for (const handle of requester.handles()) {
      expect(fingerprint(worker.resolve(handle))).toBe(
        fingerprint(requester.resolve(handle)),
      );
    }
  });

  it("assertDriftIsolation passes for a well-formed drift and a clean control", () => {
    expect(() => assertDriftIsolation(DRIFT_SCENARIO)).not.toThrow();
    expect(() => assertDriftIsolation(CLEAN_SCENARIO)).not.toThrow();
  });

  it("assertDriftIsolation throws when a drift does not change its handle", () => {
    const broken: A2aDriftScenario = {
      ...DRIFT_SCENARIO,
      id: "broken-noop",
      drift: {
        handle: "Gamma",
        fieldPath: "asset",
        before: "USDC",
        after: "USDC",
        // mutatedDefinition equals the canonical definition: no real drift.
        mutatedDefinition: { asset: "USDC", decimals: 6 },
      },
    };
    expect(() => assertDriftIsolation(broken)).toThrow(/not isolated/);
  });
});
