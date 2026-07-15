import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("defaults to the deterministic harness with the fixture backend", () => {
    const options = parseArgs([]);
    expect(options.semanticBackend).toBe("fixture");
    expect(options.orderSeed).toBe(20_260_714);
    expect(options.seedCount).toBe(1);
    expect(options.fixturePath).toMatch(/scenarios\.yaml$/);
  });

  it("accepts --repetitions as an alias for --seeds", () => {
    expect(parseArgs(["--repetitions", "5"]).seedCount).toBe(5);
    expect(parseArgs(["--seeds", "3"]).seedCount).toBe(3);
  });

  it("accepts the sema-python backend selection", () => {
    const options = parseArgs(["--semantic-backend", "sema-python"]);
    expect(options.semanticBackend).toBe("sema-python");
  });

  it("rejects an unknown backend", () => {
    expect(() => parseArgs(["--semantic-backend", "nope"])).toThrow(
      /fixture or sema-python/,
    );
  });

  it("rejects a non-positive seed count", () => {
    expect(() => parseArgs(["--seeds", "0"])).toThrow(/positive integer/);
  });

  it("rejects a negative order seed", () => {
    expect(() => parseArgs(["--order-seed", "-1"])).toThrow(
      /nonnegative integer/,
    );
  });

  it("rejects an unknown argument", () => {
    expect(() => parseArgs(["--mode", "model-pilot"])).toThrow(
      /Unknown argument/,
    );
  });
});
