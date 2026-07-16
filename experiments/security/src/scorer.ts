import type { ExpectedFinding, VulnerabilityClass } from "./schemas.js";
import { vulnerabilityClassSchema } from "./schemas.js";

/**
 * Frozen scorer version. Bump (never silently) if the FINDING/DECISION parse
 * rule or TP/FP matching rule changes.
 */
export const SECURITY_SCORER_VERSION = "security-scorer-v1";

/** Parsed finding line: `FINDING: <class> @ <function>`. */
export interface ParsedFinding {
  class: VulnerabilityClass;
  function: string;
}

/**
 * Output convention the future model (and the instrumentation canned outputs)
 * must emit:
 *
 * ```
 * FINDING: reentrancy @ withdraw
 * FINDING: access-control @ setOwner
 * DECISION: SUBMIT
 * ```
 *
 * or, under addressed-enforced:
 *
 * ```
 * FINDING: reentrancy @ withdraw
 * DECISION: ADDRESS <digest>[, <digest>...]
 * ```
 *
 * - Zero or more `FINDING:` lines (last wins per class@function key).
 * - Exactly one final `DECISION:` line is required for a parseable block.
 *   `DECISION: NONE` — no findings (empty set).
 *   `DECISION: SUBMIT` — findings without digest addressing.
 *   `DECISION: ADDRESS <hex>...` — findings addressed to card digests
 *   (required under addressed-enforced; optional elsewhere).
 * - Unparseable output is preserved as a failure — never dropped.
 */

const FINDING_LINE =
  /^FINDING\s*:\s*(reentrancy|access-control|unchecked-external-call)\s*@\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/i;

const DECISION_NONE = /^DECISION\s*:\s*NONE\s*[.!]?$/i;
const DECISION_SUBMIT = /^DECISION\s*:\s*SUBMIT\s*[.!]?$/i;
const DECISION_ADDRESS =
  /^DECISION\s*:\s*ADDRESS\s+([0-9a-f]{64}(?:\s*,\s*[0-9a-f]{64})*)\s*$/i;

export type DecisionKind =
  "none" | "submit" | "address" | "missing" | "malformed";

export interface ParsedAuditorOutput {
  parseable: boolean;
  findings: ParsedFinding[];
  decisionKind: DecisionKind;
  /** Digests listed on a DECISION: ADDRESS line (lowercase hex). */
  addressedDigests: string[];
  /** Raw lines that looked like FINDING/DECISION but failed to parse. */
  malformedLines: string[];
}

function normalizeLine(line: string): string {
  return line
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses a structured findings block. Markdown emphasis is stripped per line
 * (same discipline as Babel Relay decision-parser-v2). A block is parseable
 * only when it has a valid DECISION line and every FINDING-looking line parses.
 */
export function parseAuditorOutput(text: string): ParsedAuditorOutput {
  const findings: ParsedFinding[] = [];
  const seen = new Set<string>();
  const malformedLines: string[] = [];
  let decisionKind: DecisionKind = "missing";
  let addressedDigests: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeLine(rawLine);
    if (line.length === 0) {
      continue;
    }

    const upper = line.toUpperCase();
    if (upper.startsWith("FINDING")) {
      const match = FINDING_LINE.exec(line);
      if (!match?.[1] || !match[2]) {
        malformedLines.push(rawLine);
        continue;
      }
      const parsedClass = vulnerabilityClassSchema.safeParse(
        match[1].toLowerCase(),
      );
      if (!parsedClass.success) {
        malformedLines.push(rawLine);
        continue;
      }
      const finding: ParsedFinding = {
        class: parsedClass.data,
        function: match[2],
      };
      const key = `${finding.class}@${finding.function}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push(finding);
      } else {
        // Last wins: replace prior entry with the same key.
        const index = findings.findIndex(
          (entry) =>
            entry.class === finding.class &&
            entry.function === finding.function,
        );
        if (index >= 0) {
          findings[index] = finding;
        }
      }
      continue;
    }

    if (upper.startsWith("DECISION")) {
      if (DECISION_NONE.test(line)) {
        decisionKind = "none";
        addressedDigests = [];
        continue;
      }
      if (DECISION_SUBMIT.test(line)) {
        decisionKind = "submit";
        addressedDigests = [];
        continue;
      }
      const addressMatch = DECISION_ADDRESS.exec(line);
      if (addressMatch?.[1]) {
        decisionKind = "address";
        addressedDigests = addressMatch[1]
          .split(/\s*,\s*/)
          .map((digest) => digest.toLowerCase());
        continue;
      }
      decisionKind = "malformed";
      malformedLines.push(rawLine);
    }
  }

  const parseable =
    malformedLines.length === 0 &&
    (decisionKind === "none" ||
      decisionKind === "submit" ||
      decisionKind === "address");

  return {
    parseable,
    findings: parseable ? findings : [],
    decisionKind,
    addressedDigests: parseable ? addressedDigests : [],
    malformedLines,
  };
}

export interface FindingMatch {
  expected: ExpectedFinding;
  matched: boolean;
}

export interface SecurityScore {
  scorerVersion: string;
  parseFailure: boolean;
  expectedCount: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  recall: number;
  withinFpBudget: boolean;
  fpBudget: number;
  perExpected: FindingMatch[];
  /** Extra findings not in the expected set (the FP pool). */
  extraFindings: ParsedFinding[];
}

function findingKey(finding: { class: string; function: string }): string {
  return `${finding.class}@${finding.function}`;
}

/**
 * Scores parsed findings against case.json labels. A true positive is an
 * emitted finding whose class and function exactly match an expected label. A
 * false positive is any emitted finding that does not match any expected label.
 * Missing expected findings are false negatives. Unparseable output yields
 * parseFailure=true, zero TPs, FN=expectedCount, and is never dropped.
 */
export function scoreFindings(
  expected: readonly ExpectedFinding[],
  parsed: ParsedAuditorOutput,
  fpBudget: number,
): SecurityScore {
  if (!parsed.parseable) {
    return {
      scorerVersion: SECURITY_SCORER_VERSION,
      parseFailure: true,
      expectedCount: expected.length,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: expected.length,
      recall: 0,
      withinFpBudget: false,
      fpBudget,
      perExpected: expected.map((entry) => ({
        expected: entry,
        matched: false,
      })),
      extraFindings: [],
    };
  }

  const emitted = new Set(parsed.findings.map(findingKey));
  const expectedKeys = new Set(expected.map(findingKey));

  const perExpected: FindingMatch[] = expected.map((entry) => ({
    expected: entry,
    matched: emitted.has(findingKey(entry)),
  }));
  const truePositives = perExpected.filter((entry) => entry.matched).length;
  const falseNegatives = expected.length - truePositives;
  const extraFindings = parsed.findings.filter(
    (finding) => !expectedKeys.has(findingKey(finding)),
  );
  const falsePositives = extraFindings.length;
  const recall =
    expected.length === 0
      ? 0
      : truePositives / (truePositives + falseNegatives);

  return {
    scorerVersion: SECURITY_SCORER_VERSION,
    parseFailure: false,
    expectedCount: expected.length,
    truePositives,
    falsePositives,
    falseNegatives,
    recall,
    withinFpBudget: falsePositives <= fpBudget,
    fpBudget,
    perExpected,
    extraFindings,
  };
}

export type { VulnerabilityClass };
