import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/cli.js";
import { detectFoundry } from "../src/foundry.js";

describe("parseArgs", () => {
  it("defaults to instrumentation mode with fp-budget 1", () => {
    const options = parseArgs([]);
    expect(options.mode).toBe("instrumentation");
    expect(options.fpBudget).toBe(1);
    expect(options.orderSeed).toBe(20_260_716);
    expect(options.seedCount).toBe(1);
    expect(options.withFoundry).toBe(false);
    expect(options.semanticBackend).toBe("fixture");
  });

  it("accepts --fp-budget, --with-foundry, and --repetitions", () => {
    const options = parseArgs([
      "--fp-budget",
      "2",
      "--with-foundry",
      "--repetitions",
      "3",
    ]);
    expect(options.fpBudget).toBe(2);
    expect(options.withFoundry).toBe(true);
    expect(options.seedCount).toBe(3);
  });

  it("rejects model-pilot mode", () => {
    expect(() => parseArgs(["--mode", "model-pilot"])).toThrow(
      /instrumentation/,
    );
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--provider", "anthropic"])).toThrow(
      /Unknown argument/,
    );
  });
});

describe("detectFoundry", () => {
  it("is a no-op when not requested", async () => {
    const status = await detectFoundry(false);
    expect(status.requested).toBe(false);
    expect(status.available).toBe(false);
    expect(status.reason).toBe("not-requested");
  });

  it("reports unavailable when FOUNDRY_BIN points nowhere", async () => {
    const status = await detectFoundry(true, {
      ...process.env,
      FOUNDRY_BIN: "/no/such/forge-binary",
    });
    expect(status.requested).toBe(true);
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/FOUNDRY_BIN/);
  });
});
