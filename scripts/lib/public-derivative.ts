import {
  transcriptBlockSchema,
  trialRecordSchema,
  type TranscriptBlock,
  type TranscriptEntry,
  type TrialRecord,
} from "../../packages/core/src/schemas.js";

/**
 * Maximum number of characters retained from each transcript content block in a
 * public derivative. Text beyond this cap is dropped and a truncation marker is
 * appended, so the redacted record stays schema-valid while never committing an
 * unbounded provider payload into version control.
 */
export const TRANSCRIPT_TEXT_CAP = 20_000;

/**
 * Human-readable description of the redaction rules applied when a run bundle is
 * promoted into a public report. Written verbatim into `PROMOTED.md` so the
 * derivative policy travels with the data.
 */
export const PUBLIC_DERIVATIVE_RULES = [
  "Each transcript entry's `raw` field is replaced with `null`. Raw provider" +
    " payloads can carry provider-internal fields we do not want to commit to" +
    " forever; the experiment standard permits a redacted public derivative.",
  `Each transcript content block's \`text\` is capped at ${TRANSCRIPT_TEXT_CAP.toLocaleString(
    "en-US",
  )} characters. Truncated text is marked with a \`[truncated N chars]\` suffix.`,
  "`manifest.json` and `summary.json` are copied verbatim. Full raw trial" +
    " bundles are retained locally and are never committed.",
] as const;

function truncationMarker(droppedChars: number): string {
  return `\n[truncated ${droppedChars} chars]`;
}

/**
 * Cap a single content block's text at {@link TRANSCRIPT_TEXT_CAP} characters,
 * appending a truncation marker when text is dropped. All other fields are kept.
 */
export function redactContentBlock(block: TranscriptBlock): TranscriptBlock {
  const { text } = block;
  if (text === null || text.length <= TRANSCRIPT_TEXT_CAP) {
    return block;
  }
  const droppedChars = text.length - TRANSCRIPT_TEXT_CAP;
  return {
    ...block,
    text: `${text.slice(0, TRANSCRIPT_TEXT_CAP)}${truncationMarker(droppedChars)}`,
  };
}

/**
 * Strip a transcript entry's `raw` payload and cap every content block's text.
 */
export function redactTranscriptEntry(entry: TranscriptEntry): TranscriptEntry {
  return {
    ...entry,
    content: entry.content.map(redactContentBlock),
    raw: null,
  };
}

/**
 * Produce the public derivative of a single trial record: raw transcript
 * payloads removed and content blocks capped. The result is re-validated against
 * {@link trialRecordSchema} so a malformed derivative fails loudly rather than
 * being committed. All non-transcript fields (metrics, provenance, events,
 * usage) are preserved unchanged.
 */
export function redactTrialRecord(record: TrialRecord): TrialRecord {
  const transcript =
    record.transcript === null
      ? null
      : { entries: record.transcript.entries.map(redactTranscriptEntry) };
  const derivative: TrialRecord = { ...record, transcript };
  return trialRecordSchema.parse(derivative);
}

/**
 * Parse and redact a full `trials.jsonl` document into public-derivative JSONL
 * text. Blank lines are skipped; every non-blank line must be a schema-valid
 * trial record.
 */
export function buildPublicTrialsJsonl(source: string): string {
  const records = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => trialRecordSchema.parse(JSON.parse(line)))
    .map(redactTrialRecord);

  // Re-validate content blocks defensively; a truncated block must still parse.
  for (const record of records) {
    for (const entry of record.transcript?.entries ?? []) {
      for (const block of entry.content) {
        transcriptBlockSchema.parse(block);
      }
    }
  }

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
