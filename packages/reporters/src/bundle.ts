import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
