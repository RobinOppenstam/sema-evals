import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { runProcess } from "../src/process.js";

describe("bounded process capture", () => {
  test("preserves a capped prefix and hashes the complete overflow stream", async () => {
    const payload = "x".repeat(100_000);
    const result = await runProcess(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(payload)})`],
      { timeoutMs: 10_000, maxOutputBytes: 1024 },
    );
    expect(result.outputOverflow).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(1024);
    expect(result.stdoutDigest).toBe(
      createHash("sha256").update(payload).digest("hex"),
    );
  });

  test("preserves nonzero exits and timeout state", async () => {
    const nonzero = await runProcess(
      process.execPath,
      ["-e", "process.stderr.write('bad'); process.exit(9)"],
      { timeoutMs: 10_000 },
    );
    expect(nonzero.exitCode).toBe(9);
    expect(nonzero.stderr).toBe("bad");
    const timeout = await runProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 25 },
    );
    expect(timeout.timedOut).toBe(true);
  });
});
