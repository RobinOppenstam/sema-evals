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

export async function writeResultBundle(
  directory: string,
  manifest: ResultManifest,
  records: readonly TrialRecord[],
): Promise<ResultBundle> {
  const validManifest = resultManifestSchema.parse(manifest);
  const validRecords = records.map((record) => trialRecordSchema.parse(record));
  const summary = summarizeTrials(validRecords);

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
    writeFile(summaryMarkdownPath, summaryMarkdown(summary), "utf8"),
  ]);

  return {
    directory,
    manifestPath,
    trialsPath,
    summaryJsonPath,
    summaryMarkdownPath,
  };
}
