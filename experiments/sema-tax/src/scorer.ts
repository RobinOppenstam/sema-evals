import type {
  SemaTaxComparator,
  SemaTaxItem,
  SemaTaxPattern,
} from "./schemas.js";

/**
 * Frozen scorer version. The worksheet scorer is executable: each item's ground
 * truth is a numeric comparison derived from its pattern definition, and the
 * agent's answer is parsed from a strict `ITEM <id>: yes|no` line. No LLM judge
 * is ever the source of truth. Bump this string (and never silently) if the
 * parsing or ground-truth rule changes.
 */
export const SEMA_TAX_SCORER_VERSION = "sema-tax-worksheet-scorer-v2";

export type WorksheetAnswer = "yes" | "no";

/** Evaluates an item against its pattern definition. This is the ground truth. */
export function evaluateItem(
  pattern: SemaTaxPattern,
  value: number,
): WorksheetAnswer {
  return compare(pattern.comparator, value, pattern.threshold) ? "yes" : "no";
}

function compare(
  comparator: SemaTaxComparator,
  left: number,
  right: number,
): boolean {
  switch (comparator) {
    case ">=":
      return left >= right;
    case ">":
      return left > right;
    case "<=":
      return left <= right;
    case "<":
      return left < right;
    case "==":
      return left === right;
  }
}

const ANSWER_LINE = /^ITEM\s+([a-z0-9][a-z0-9-]*)\s*:\s*(YES|NO)\s*[.!]?$/i;

/**
 * Parses `ITEM <id>: yes|no` answer lines from a model (or simulated) response.
 * Markdown emphasis and heading markers are stripped per line before matching,
 * mirroring the Babel Relay decision parser (scorer hardening learned in
 * Phase 1). The last answer for a given item wins; anything else is ignored.
 */
export function parseWorksheetAnswers(
  text: string,
): Map<string, WorksheetAnswer> {
  const answers = new Map<string, WorksheetAnswer>();
  for (const line of text.split(/\r?\n/)) {
    const normalized = line
      .replace(/[*_`#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const match = ANSWER_LINE.exec(normalized);
    if (match?.[1] && match[2]) {
      answers.set(match[1], match[2].toUpperCase() === "YES" ? "yes" : "no");
    }
  }
  return answers;
}

export interface ItemScore {
  id: string;
  expected: WorksheetAnswer;
  answered: WorksheetAnswer | "missing";
  correct: boolean;
}

export interface WorksheetScore {
  scorerVersion: string;
  itemsTotal: number;
  /** Items with a parseable `ITEM <id>: yes|no` line for that item's id. This
   * separates format compliance from correctness: an item can be answered yet
   * wrong. Unanswered items = itemsTotal - itemsAnswered. Duplicate lines for one
   * id count once (the parser keeps only the last). */
  itemsAnswered: number;
  itemsCorrect: number;
  score: number;
  taskSuccess: boolean;
  perItem: ItemScore[];
}

/**
 * Scores a response against the worksheet ground truth. An item is correct only
 * when the parsed answer exactly matches the executable ground truth; a missing
 * or malformed answer is wrong (never dropped). `score` is the correct fraction;
 * `taskSuccess` requires every item correct. `itemsAnswered` additionally reports
 * format compliance — how many items got a parseable answer line at all — so a
 * wrong answer is distinguishable from no answer without re-parsing transcripts.
 */
export function scoreWorksheet(
  items: readonly SemaTaxItem[],
  patternsByHandle: ReadonlyMap<string, SemaTaxPattern>,
  responseText: string,
): WorksheetScore {
  const answers = parseWorksheetAnswers(responseText);
  const perItem: ItemScore[] = items.map((item) => {
    const pattern = patternsByHandle.get(item.patternHandle);
    if (!pattern) {
      throw new Error(
        `Item ${item.id} references unknown pattern ${item.patternHandle}.`,
      );
    }
    const expected = evaluateItem(pattern, item.value);
    const answered = answers.get(item.id) ?? "missing";
    return { id: item.id, expected, answered, correct: answered === expected };
  });
  const itemsCorrect = perItem.filter((entry) => entry.correct).length;
  const itemsAnswered = perItem.filter(
    (entry) => entry.answered !== "missing",
  ).length;
  return {
    scorerVersion: SEMA_TAX_SCORER_VERSION,
    itemsTotal: items.length,
    itemsAnswered,
    itemsCorrect,
    score: items.length === 0 ? 0 : itemsCorrect / items.length,
    taskSuccess: itemsCorrect === items.length,
    perItem,
  };
}
