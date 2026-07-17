import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createResultJournalWith } from "../src/bundle.js";

interface RecordFixture {
  executionIndex: number;
  value: string;
}

interface ManifestFixture {
  runId: string;
  trialCount: number;
}

const recordSchema = {
  parse(value: unknown): RecordFixture {
    if (
      typeof value !== "object" ||
      value === null ||
      !("executionIndex" in value) ||
      !("value" in value) ||
      typeof value.executionIndex !== "number" ||
      typeof value.value !== "string"
    ) {
      throw new Error("invalid record");
    }
    return {
      executionIndex: value.executionIndex,
      value: value.value,
    };
  },
};

const manifestSchema = {
  parse(value: unknown): ManifestFixture {
    if (
      typeof value !== "object" ||
      value === null ||
      !("runId" in value) ||
      !("trialCount" in value) ||
      typeof value.runId !== "string" ||
      typeof value.trialCount !== "number"
    ) {
      throw new Error("invalid manifest");
    }
    return { runId: value.runId, trialCount: value.trialCount };
  },
};

const spec = {
  manifestSchema,
  recordSchema,
  summarize: (records: readonly RecordFixture[]) => ({
    values: records.map((record) => record.value),
  }),
  renderMarkdown: (summary: { values: string[] }) =>
    `${summary.values.join(",")}\n`,
};

function directory(name: string): string {
  return join(
    tmpdir(),
    `sema-evals-journal-${name}-${process.pid}-${Date.now()}-${Math.random()}`,
  );
}

describe("createResultJournalWith", () => {
  it("persists a manifest and every settled trial before finalization", async () => {
    const journal = await createResultJournalWith(
      directory("partial"),
      { runId: "run-partial", trialCount: 2 },
      spec,
    );

    await Promise.all([
      journal.append({ executionIndex: 1, value: "second-settled" }),
      journal.append({ executionIndex: 0, value: "first-planned" }),
    ]);
    await journal.fail(new Error("later leakage gate failed"));

    const manifest = JSON.parse(await readFile(journal.manifestPath, "utf8"));
    expect(manifest.runId).toBe("run-partial");
    const partial = await readFile(journal.partialTrialsPath, "utf8");
    expect(partial.trim().split("\n")).toHaveLength(2);
    const state = JSON.parse(await readFile(journal.runStatePath, "utf8"));
    expect(state).toMatchObject({
      status: "failed",
      settledTrialCount: 2,
    });
    expect(state.error).toMatch(/later leakage gate failed/);
  });

  it("finalizes canonical trials in caller-provided planned order", async () => {
    const journal = await createResultJournalWith(
      directory("complete"),
      { runId: "run-complete", trialCount: 2 },
      spec,
    );
    const first = { executionIndex: 0, value: "first" };
    const second = { executionIndex: 1, value: "second" };
    await journal.append(second);
    await journal.append(first);

    const bundle = await journal.finalize([first, second]);

    const canonical = (await readFile(bundle.trialsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => recordSchema.parse(JSON.parse(line)));
    expect(canonical.map((record) => record.value)).toEqual([
      "first",
      "second",
    ]);
    const state = JSON.parse(await readFile(journal.runStatePath, "utf8"));
    expect(state).toMatchObject({
      status: "completed",
      settledTrialCount: 2,
    });
  });
});
