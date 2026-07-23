import { describe, expect, it } from "vitest";

import { runX402SdkTransportConformance } from "../src/conformance.js";

describe("official x402 SDK loopback conformance", () => {
  it("exercises V2 payment retry locally and fail-closes invalid fixtures", async () => {
    const result = await runX402SdkTransportConformance();

    expect(result).toMatchObject({
      ready: true,
      externalNetworkAccessed: false,
      attemptedExternalEgress: false,
      productionWriteAttempted: false,
      requestCounts: {
        happy: 2,
        malformed: 1,
        v1: 1,
        repeated402: 2,
        invalidCaip2: 1,
        missingExtension: 2,
        invalidExtension: 2,
      },
    });
    expect(result.checkedHeaders).toEqual([
      "PAYMENT-REQUIRED",
      "PAYMENT-SIGNATURE",
      "PAYMENT-RESPONSE",
    ]);
    expect(result.failures).toEqual([]);
  });
});
