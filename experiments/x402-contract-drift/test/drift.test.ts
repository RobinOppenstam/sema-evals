import { fingerprint } from "@sema-evals/core";
import { describe, expect, it } from "vitest";

import {
  assertDriftIsolation,
  buildPayerRegistry,
  buildSellerRegistry,
} from "../src/registry.js";
import type { X402DriftScenario } from "../src/schemas.js";

const BASE_PATTERNS = [
  { handle: "Alpha", definition: { comparator: "<=", threshold: 50 } },
  { handle: "Beta", definition: { comparator: ">=", threshold: 2 } },
  { handle: "Gamma", definition: { asset: "USDC", decimals: 6 } },
];

const DRIFT_SCENARIO: X402DriftScenario = {
  id: "drift",
  title: "t",
  description: "d",
  resourceDescription: "r",
  resource: "https://api.example.com/r",
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0xasset",
  payTo: "0xpayto",
  maxTimeoutSeconds: 60,
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

const CLEAN_SCENARIO: X402DriftScenario = {
  ...DRIFT_SCENARIO,
  id: "clean",
  drift: null,
};

describe("drift injection", () => {
  it("mutates exactly the drifted handle in the payer registry", () => {
    const seller = buildSellerRegistry(DRIFT_SCENARIO);
    const payer = buildPayerRegistry(DRIFT_SCENARIO);
    expect(fingerprint(payer.resolve("Gamma"))).not.toBe(
      fingerprint(seller.resolve("Gamma")),
    );
    expect(payer.resolve("Gamma")["asset"]).toBe("USDT");
    for (const handle of ["Alpha", "Beta"]) {
      expect(fingerprint(payer.resolve(handle))).toBe(
        fingerprint(seller.resolve(handle)),
      );
    }
  });

  it("leaves the payer registry identical to the seller's for a no-drift control", () => {
    const seller = buildSellerRegistry(CLEAN_SCENARIO);
    const payer = buildPayerRegistry(CLEAN_SCENARIO);
    for (const handle of seller.handles()) {
      expect(fingerprint(payer.resolve(handle))).toBe(
        fingerprint(seller.resolve(handle)),
      );
    }
  });

  it("assertDriftIsolation passes for a well-formed drift and a clean control", () => {
    expect(() => assertDriftIsolation(DRIFT_SCENARIO)).not.toThrow();
    expect(() => assertDriftIsolation(CLEAN_SCENARIO)).not.toThrow();
  });

  it("assertDriftIsolation fails closed when a drift does not change its handle (fixture typo)", () => {
    const broken: X402DriftScenario = {
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

  it("assertDriftIsolation fails closed when the declared handle is not the one that changed", () => {
    // Fixture typo: declares Beta as drifted, but mutatedDefinition equals
    // Beta's canonical — so no handle actually changes.
    const mislabeled: X402DriftScenario = {
      ...DRIFT_SCENARIO,
      id: "broken-mislabeled",
      drift: {
        handle: "Beta",
        fieldPath: "threshold",
        before: 2,
        after: 9,
        mutatedDefinition: { comparator: ">=", threshold: 2 },
      },
    };
    expect(() => assertDriftIsolation(mislabeled)).toThrow(/not isolated/);
  });
});
