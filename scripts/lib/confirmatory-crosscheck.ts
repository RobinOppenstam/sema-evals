// -------------------------------------------------------------------------
// Confirmatory analysis cross-check
//
// The site recomputes a confirmatory run's registered analysis (hypothesis
// intervals + verdict) from its public trials at build time. If a bundle ALSO
// ships an analysis JSON, this compares the two and returns a list of
// disagreements; the adapter throws on any (same policy as the summary
// recompute). It only reads the shipped object — it never trusts it.
//
// The shipped analysis may be a single-arm ModelAnalysis or a multi-arm
// ConfirmatoryReport (the analyze CLI's `--json` shape); this resolves the arm
// either way and cross-checks the verdict-bearing fields, tolerant of a loose
// or partial JSON (an absent field is not a mismatch, a present-but-different
// one is), so a schema drift surfaces as a warning rather than a hard crash.
// -------------------------------------------------------------------------

import type { ModelAnalysis } from "../../experiments/babel-relay/src/confirmatory-analysis.js";

/** Floats agree within this tolerance (rates and interval bounds). */
const EPSILON = 1e-9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Resolve the shipped analysis for a single arm: the object itself when it is a
 * ModelAnalysis, or the matching entry of a ConfirmatoryReport's `models[]`.
 */
function resolveArm(
  shipped: unknown,
  arm: string,
): Record<string, unknown> | undefined {
  if (!isRecord(shipped)) {
    return undefined;
  }
  if (Array.isArray(shipped.models)) {
    return shipped.models.filter(isRecord).find((model) => model.arm === arm);
  }
  return shipped;
}

function compareInt(
  warnings: string[],
  field: string,
  shipped: unknown,
  recomputed: number,
): void {
  const value = num(shipped);
  if (value !== undefined && value !== recomputed) {
    warnings.push(`${field}: analysis=${value} recomputed=${recomputed}`);
  }
}

function compareFloat(
  warnings: string[],
  field: string,
  shipped: unknown,
  recomputed: number,
): void {
  const value = num(shipped);
  if (value !== undefined && Math.abs(value - recomputed) > EPSILON) {
    warnings.push(`${field}: analysis=${value} recomputed=${recomputed}`);
  }
}

function compareBool(
  warnings: string[],
  field: string,
  shipped: unknown,
  recomputed: boolean,
): void {
  const value = bool(shipped);
  if (value !== undefined && value !== recomputed) {
    warnings.push(`${field}: analysis=${value} recomputed=${recomputed}`);
  }
}

/**
 * Cross-check a recomputed {@link ModelAnalysis} against a bundle's shipped
 * analysis JSON. Returns a list of human-readable disagreements; an empty list
 * means the shipped analysis is faithful to the recomputed one.
 */
export function crossCheckAnalysis(
  recomputed: ModelAnalysis,
  shipped: unknown,
  arm: string,
): string[] {
  const warnings: string[] = [];
  const model = resolveArm(shipped, arm);
  if (model === undefined) {
    return [
      `analysis.json ships no arm matching "${arm}" (expected a ModelAnalysis or a report with a matching models[] entry)`,
    ];
  }

  compareBool(warnings, "confirmed", model.confirmed, recomputed.confirmed);

  if (isRecord(model.exclusions)) {
    const e = model.exclusions;
    compareInt(
      warnings,
      "exclusions.excluded",
      e.excluded,
      recomputed.exclusions.excluded,
    );
    compareFloat(
      warnings,
      "exclusions.excludedRate",
      e.excludedRate,
      recomputed.exclusions.excludedRate,
    );
    compareBool(
      warnings,
      "exclusions.infrastructureInvalid",
      e.infrastructureInvalid,
      recomputed.exclusions.infrastructureInvalid,
    );
  }

  if (Array.isArray(model.hypotheses)) {
    const shippedChecks = model.hypotheses.filter(isRecord);
    for (const check of recomputed.hypotheses) {
      const key = `${check.id}${check.condition ? `(${check.condition})` : ""}`;
      const match = shippedChecks.find(
        (candidate) =>
          candidate.id === check.id && candidate.condition === check.condition,
      );
      if (match === undefined) {
        warnings.push(`hypothesis ${key}: missing from analysis.json`);
        continue;
      }
      compareBool(warnings, `${key}.pass`, match.pass, check.pass);
      compareInt(
        warnings,
        `${key}.numerator`,
        match.numerator,
        check.numerator,
      );
      compareInt(
        warnings,
        `${key}.denominator`,
        match.denominator,
        check.denominator,
      );
      compareFloat(
        warnings,
        `${key}.pointEstimate`,
        match.pointEstimate,
        check.pointEstimate,
      );
      if (isRecord(match.interval)) {
        compareFloat(
          warnings,
          `${key}.interval.lower`,
          match.interval.lower,
          check.interval.lower,
        );
        compareFloat(
          warnings,
          `${key}.interval.upper`,
          match.interval.upper,
          check.interval.upper,
        );
      }
    }
  }

  return warnings;
}
