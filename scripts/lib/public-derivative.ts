import {
  transcriptBlockSchema,
  trialRecordSchema,
  type Transcript,
  type TranscriptBlock,
  type TranscriptEntry,
  type TrialRecord,
} from "../../packages/core/src/schemas.js";

/**
 * The only shape the redactor needs from a trial record: a nullable transcript.
 * Both the babel-relay core record and the sema-tax record satisfy this (both
 * reuse core's {@link Transcript} shape), so the same redaction policy applies
 * to every experiment without duplicating the transcript-capping logic.
 */
export interface RedactableRecord {
  transcript: Transcript | null;
}

/**
 * Structural view of a Zod schema's parse gate — just enough to validate a JSON
 * line into a typed record. Declared structurally so this module needs no direct
 * `zod` dependency; every experiment's record schema satisfies it.
 */
export interface RecordSchema<T> {
  parse(data: unknown): T;
}

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
 * Strip raw transcript payloads and cap content-block text on any record that
 * carries a nullable {@link Transcript}. Non-transcript fields (metrics,
 * provenance, events, usage) are preserved unchanged. Schema-agnostic so both
 * the babel-relay and sema-tax records get the identical redaction policy.
 */
export function redactRecordTranscript<T extends RedactableRecord>(
  record: T,
): T {
  const transcript =
    record.transcript === null
      ? null
      : { entries: record.transcript.entries.map(redactTranscriptEntry) };
  return { ...record, transcript };
}

/**
 * Produce the public derivative of a single core trial record: raw transcript
 * payloads removed and content blocks capped. The result is re-validated against
 * {@link trialRecordSchema} so a malformed derivative fails loudly rather than
 * being committed.
 */
export function redactTrialRecord(record: TrialRecord): TrialRecord {
  return trialRecordSchema.parse(redactRecordTranscript(record));
}

/**
 * Parse and redact a full `trials.jsonl` document into public-derivative JSONL
 * text. Blank lines are skipped; every non-blank line must validate against
 * `recordSchema` (the core {@link trialRecordSchema} by default, or an
 * experiment-specific record schema such as the sema-tax record). The redaction
 * policy — strip `raw`, cap transcript text — is identical across experiments.
 */
export function buildPublicTrialsJsonl<T extends RedactableRecord>(
  source: string,
  recordSchema: RecordSchema<T> = trialRecordSchema as unknown as RecordSchema<T>,
): string {
  const records = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => recordSchema.parse(JSON.parse(line)))
    .map(redactRecordTranscript)
    // Re-validate the redacted record so a malformed derivative fails loudly.
    .map((record) => recordSchema.parse(record));

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
