import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { parseArgs, runForecastingCli } from "../src/cli.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = join(ROOT, "fixtures/scenarios.yaml");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("parseArgs", () => {
  it("defaults to the fixture backend and deterministic paths", () => {
    const options = parseArgs([]);
    expect(options.semanticBackend).toBe("fixture");
    expect(options.orderSeed).toBe(20_260_716);
    expect(options.seedCount).toBe(1);
    expect(options.fixturePath).toMatch(/scenarios\.yaml$/);
    expect(options.mode).toBe("deterministic-harness");
  });

  it("accepts the sema-python backend selection", () => {
    const options = parseArgs(["--semantic-backend", "sema-python"]);
    expect(options.semanticBackend).toBe("sema-python");
  });

  it("accepts --seeds and --order-seed", () => {
    expect(parseArgs(["--seeds", "3"]).seedCount).toBe(3);
    expect(parseArgs(["--order-seed", "42"]).orderSeed).toBe(42);
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
    expect(() => parseArgs(["--not-a-flag"])).toThrow(/Unknown argument/);
  });

  it("rejects model-pilot explicitly because no provider path is implemented", () => {
    expect(() => parseArgs(["--mode", "model-pilot"])).toThrow(
      /model-pilot is not implemented/,
    );
  });
});

describe("failed bundle preservation", () => {
  it("writes records, summary, manifest, and leakage audit before failing the gate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forecasting-failed-"));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, "scenarios.yaml");
    const outputRoot = join(directory, "results");
    const fixture = await readFile(FIXTURE_PATH, "utf8");
    await writeFile(
      fixturePath,
      fixture.replace('verdict: "keep"', 'verdict: "drop"'),
      "utf8",
    );

    await expect(
      runForecastingCli(["--fixtures", fixturePath, "--output", outputRoot]),
    ).rejects.toThrow(/failed result bundle preserved/);

    const runs = await readdir(outputRoot);
    expect(runs).toHaveLength(1);
    const runDirectory = join(outputRoot, runs[0]!);
    const manifest = JSON.parse(
      await readFile(join(runDirectory, "manifest.json"), "utf8"),
    );
    expect(manifest.leakageAuditPassed).toBe(false);
    expect(await readFile(join(runDirectory, "trials.jsonl"), "utf8")).not.toBe(
      "",
    );
    expect(
      JSON.parse(await readFile(join(runDirectory, "summary.json"), "utf8"))
        .leakageAuditPassed,
    ).toBe(false);
    expect(
      JSON.parse(
        await readFile(join(runDirectory, "leakage-audit.json"), "utf8"),
      ).entries.some(
        (entry: { audit: { verdict: string } }) =>
          entry.audit.verdict === "drop",
      ),
    ).toBe(true);
  });
});
