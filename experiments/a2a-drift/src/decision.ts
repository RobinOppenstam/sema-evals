/**
 * Frozen, versioned parser for the model worker's terminal DECISION line.
 *
 * The model must end with a line of the form
 * `DECISION: proceed|halt — <reason>` (reason optional). Scorer discipline
 * mirrors babel-relay (ADR 0006): markdown emphasis around the keyword is
 * stripped, matching is case-insensitive, the last matching line wins, and
 * anything else is preserved as `malformed` — never dropped (ADR 0005).
 */

export const A2A_DECISION_PARSER_VERSION = "a2a-decision-parser-v1";

export type WorkerDecision = "proceed" | "halt" | "malformed";

/**
 * Accepts an optional reason after an em-dash, en-dash, hyphen, or colon.
 * Trailing punctuation after the verdict (without a reason) is also tolerated.
 */
const DECISION_LINE =
  /^DECISION\s*:\s*(PROCEED|HALT)(?:\s*[.!])?(?:\s*[—–\-:]\s*.*)?\s*$/i;

/**
 * Parses the worker model's decision from its final output. Markdown emphasis
 * and heading markers are stripped per line before matching; the last line that
 * matches the convention wins; anything else is `malformed`.
 */
export function parseWorkerDecision(text: string): WorkerDecision {
  let decision: WorkerDecision = "malformed";
  for (const line of text.split(/\r?\n/)) {
    const normalized = line
      .replace(/[*_`#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const match = DECISION_LINE.exec(normalized);
    if (match) {
      decision = match[1]?.toUpperCase() === "HALT" ? "halt" : "proceed";
    }
  }
  return decision;
}
