import type { ParsedAuditorOutput } from "./scorer.js";

/**
 * Deterministic enforcement gate for `addressed-enforced`.
 *
 * The auditor must emit `DECISION: ADDRESS <digest>[, <digest>...]` covering
 * every required Pattern Card digest. Findings that do not address the required
 * references are refused — the gate returns an empty finding set and
 * `refused: true`, so the scorer records them as misses rather than accepting
 * unaddressed claims.
 */
export interface EnforcementGateResult {
  refused: boolean;
  reason: string | null;
  /** Findings admitted after the gate (empty when refused). */
  admitted: ParsedAuditorOutput;
}

export function applyEnforcementGate(
  parsed: ParsedAuditorOutput,
  requiredDigests: readonly string[],
): EnforcementGateResult {
  if (!parsed.parseable) {
    return {
      refused: true,
      reason: "unparseable-auditor-output",
      admitted: {
        parseable: false,
        findings: [],
        decisionKind: parsed.decisionKind,
        addressedDigests: [],
        malformedLines: parsed.malformedLines,
      },
    };
  }

  if (requiredDigests.length === 0) {
    return { refused: false, reason: null, admitted: parsed };
  }

  if (parsed.decisionKind !== "address") {
    return {
      refused: true,
      reason: "missing-address-decision",
      admitted: {
        parseable: true,
        findings: [],
        decisionKind: parsed.decisionKind,
        addressedDigests: [],
        malformedLines: [],
      },
    };
  }

  const addressed = new Set(
    parsed.addressedDigests.map((digest) => digest.toLowerCase()),
  );
  const missing = requiredDigests.filter(
    (digest) => !addressed.has(digest.toLowerCase()),
  );
  if (missing.length > 0) {
    return {
      refused: true,
      reason: `missing-required-digests:${missing.join(",")}`,
      admitted: {
        parseable: true,
        findings: [],
        decisionKind: "address",
        addressedDigests: parsed.addressedDigests,
        malformedLines: [],
      },
    };
  }

  return { refused: false, reason: null, admitted: parsed };
}
