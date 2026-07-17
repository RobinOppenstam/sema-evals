import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  resultManifestSchema,
  trialRecordSchema,
  type ResultManifest,
  type TrialRecord,
} from "@sema-evals/core";

import { summarizeTrials, summaryMarkdown } from "./summary.js";

export interface ResultBundle {
  directory: string;
  manifestPath: string;
  trialsPath: string;
  summaryJsonPath: string;
  summaryMarkdownPath: string;
}

export interface ResultJournal<Record> {
  directory: string;
  manifestPath: string;
  partialTrialsPath: string;
  runStatePath: string;
  append(record: Record): Promise<void>;
  fail(error: unknown): Promise<void>;
  finalize(records: readonly Record[]): Promise<ResultBundle>;
}

/** Anything with a Zod-style `parse` gate. Lets the generic bundle writer stay
 * experiment-agnostic without importing zod: an experiment supplies its own
 * record and manifest schemas, whatever their shape. */
export interface ParseGate<T> {
  parse(value: unknown): T;
}

export interface BundleSpec<Record, Manifest, Summary> {
  /** Validates the manifest before it is written. */
  manifestSchema: ParseGate<Manifest>;
  /** Validates every trial record before it is written. */
  recordSchema: ParseGate<Record>;
  /** Reduces the validated records to the machine-readable `summary.json`. */
  summarize: (records: readonly Record[]) => Summary;
  /** Renders the human-readable `summary.md`. */
  renderMarkdown: (summary: Summary) => string;
}

interface RunState {
  status: "running" | "failed" | "completed";
  startedAt: string;
  updatedAt: string;
  settledTrialCount: number;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

/**
 * Creates the durable shell of a result bundle before execution begins.
 *
 * Every settled record is validated and appended to `trials.partial.jsonl`.
 * The append queue is serialized, so concurrent matrix workers cannot
 * interleave writes. The canonical `trials.jsonl` and summaries are still
 * produced only by {@link finalize}, in planned order, preserving historical
 * deterministic bundle bytes. Interrupted and failed runs retain their
 * manifest, partial journal, and machine-readable run state.
 */
export async function createResultJournalWith<Record, Manifest, Summary>(
  directory: string,
  manifest: Manifest,
  spec: BundleSpec<Record, Manifest, Summary>,
): Promise<ResultJournal<Record>> {
  const validManifest = spec.manifestSchema.parse(manifest);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);

  const manifestPath = join(directory, "manifest.json");
  const partialTrialsPath = join(directory, "trials.partial.jsonl");
  const runStatePath = join(directory, "run-state.json");
  const startedAt = new Date().toISOString();
  let settledTrialCount = 0;
  let appendQueue = Promise.resolve();

  const writeState = async (
    status: RunState["status"],
    error: string | null,
  ): Promise<void> => {
    const state: RunState = {
      status,
      startedAt,
      updatedAt: new Date().toISOString(),
      settledTrialCount,
      error,
    };
    await writeFile(
      runStatePath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  };

  await Promise.all([
    writeFile(
      manifestPath,
      `${JSON.stringify(validManifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(partialTrialsPath, "", "utf8"),
    writeState("running", null),
  ]);

  const append = async (record: Record): Promise<void> => {
    const validRecord = spec.recordSchema.parse(record);
    appendQueue = appendQueue.then(async () => {
      await appendFile(
        partialTrialsPath,
        `${JSON.stringify(validRecord)}\n`,
        "utf8",
      );
      settledTrialCount += 1;
      await writeState("running", null);
    });
    await appendQueue;
  };

  const fail = async (error: unknown): Promise<void> => {
    await appendQueue;
    await writeState("failed", errorMessage(error));
  };

  const finalize = async (
    records: readonly Record[],
  ): Promise<ResultBundle> => {
    await appendQueue;
    const bundle = await writeResultBundleWith(
      directory,
      validManifest,
      records,
      spec,
    );
    await writeState("completed", null);
    return bundle;
  };

  return {
    directory,
    manifestPath,
    partialTrialsPath,
    runStatePath,
    append,
    fail,
    finalize,
  };
}

/**
 * Writes a result bundle (manifest + trials.jsonl + summary.json + summary.md)
 * for any experiment. The record and manifest schemas, the summarizer, and the
 * markdown renderer are all supplied by the caller, so this stays agnostic to a
 * given experiment's record shape. Records are written in the order given —
 * callers pass them in planned (execution) order — so a bundle is reproducible.
 */
export async function writeResultBundleWith<Record, Manifest, Summary>(
  directory: string,
  manifest: Manifest,
  records: readonly Record[],
  spec: BundleSpec<Record, Manifest, Summary>,
): Promise<ResultBundle> {
  const validManifest = spec.manifestSchema.parse(manifest);
  const validRecords = records.map((record) => spec.recordSchema.parse(record));
  const summary = spec.summarize(validRecords);

  await mkdir(directory, { recursive: true });

  const manifestPath = join(directory, "manifest.json");
  const trialsPath = join(directory, "trials.jsonl");
  const summaryJsonPath = join(directory, "summary.json");
  const summaryMarkdownPath = join(directory, "summary.md");

  await Promise.all([
    writeFile(
      manifestPath,
      `${JSON.stringify(validManifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      trialsPath,
      `${validRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    ),
    writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    writeFile(summaryMarkdownPath, spec.renderMarkdown(summary), "utf8"),
  ]);

  return {
    directory,
    manifestPath,
    trialsPath,
    summaryJsonPath,
    summaryMarkdownPath,
  };
}

/**
 * Writes the Babel Relay result bundle. A thin, behavior-preserving wrapper over
 * {@link writeResultBundleWith} bound to the relay's core schemas and summary;
 * its output bytes are unchanged.
 */
export async function writeResultBundle(
  directory: string,
  manifest: ResultManifest,
  records: readonly TrialRecord[],
): Promise<ResultBundle> {
  return writeResultBundleWith(directory, manifest, records, {
    manifestSchema: resultManifestSchema,
    recordSchema: trialRecordSchema,
    summarize: summarizeTrials,
    renderMarkdown: summaryMarkdown,
  });
}
