import {
  referencesMatch,
  type SemanticReference as ProviderReference,
  type SemanticReferenceProvider,
} from "@sema-evals/adapters";

import type { AgentRegistry } from "./registry.js";
import {
  SEMANTIC_MISMATCH_REASON,
  type ForecastObject,
  type ForecastingCondition,
  type SemanticReference,
} from "./schemas.js";
import { conditionPolicy } from "./conditions.js";
import { meanProbability } from "./scoring.js";

/**
 * Aggregation middleware for the forecasting council.
 *
 * Kept separable from the demo harness: a pure function of forecast objects,
 * registries, and the condition policy.
 *
 * - baseline: blind raw mean of reported numbers (no format normalization,
 *   no digest check) — this is how 0.62 averaged with 62 produces garbage.
 * - addressed-voluntary: verify digests against the canonical vocabulary,
 *   surface mismatches, still aggregate ALL forecasts after normalizing each
 *   by its own ProbabilityFormat.
 * - addressed-enforced: exclude any forecast whose cited references mismatch;
 *   aggregate the aligned subset after format normalization.
 */

export interface ReferenceCheck {
  agentId: string;
  handle: string;
  expectedRef: string;
  observedRef: string;
  matched: boolean;
}

export interface AgentVerification {
  agentId: string;
  checks: ReferenceCheck[];
  matched: boolean;
}

export interface AggregationResult {
  included: ForecastObject[];
  excluded: ForecastObject[];
  exclusionReasons: Map<string, string>;
  verifications: AgentVerification[];
  referencesChecked: number;
  referencesMatched: number;
  referencesMismatched: number;
  driftDetected: boolean;
  /** Unit-interval aggregate, or null if nothing included. */
  aggregateProbability: number | null;
  /** Per-included-agent unit-interval probabilities used in the mean. */
  normalizedIncluded: number[];
}

function toProviderReference(reference: SemanticReference): ProviderReference {
  return {
    handle: reference.handle,
    display: `${reference.handle}#${reference.digest.slice(0, 4)}`,
    full: reference.ref,
    digest: reference.digest,
    backend: reference.canonicalizationVersion,
    officialSema: false,
  };
}

/**
 * Reads the ProbabilityFormat definition and normalizes a reported probability
 * onto the unit interval. Canonical scale is `"unit"` (0–1); `"percent"`
 * divides by 100. Unknown scales throw — fixtures must be explicit.
 */
export function normalizeProbability(
  reported: number,
  probabilityFormat: Record<string, unknown>,
): number {
  const scale = probabilityFormat["scale"];
  if (scale === "unit") {
    return reported;
  }
  if (scale === "percent") {
    return reported / 100;
  }
  throw new Error(
    `ProbabilityFormat.scale must be "unit" or "percent"; got ${String(scale)}.`,
  );
}

/**
 * Verifies one forecast's cited references against the canonical registry.
 * The forecast's cited digests are compared to digests recomputed from the
 * canonical definitions through the same reference provider.
 */
export async function verifyForecastReferences(
  forecast: ForecastObject,
  canonicalRegistry: AgentRegistry,
  referenceProvider: SemanticReferenceProvider,
): Promise<AgentVerification> {
  const checks: ReferenceCheck[] = [];
  for (const cited of forecast.citedReferences) {
    const canonicalDefinition = canonicalRegistry.resolve(cited.handle);
    const expected = await referenceProvider.reference(
      cited.handle,
      canonicalDefinition,
    );
    const matched = referencesMatch(expected, toProviderReference(cited));
    checks.push({
      agentId: forecast.agentId,
      handle: cited.handle,
      expectedRef: expected.full,
      observedRef: cited.ref,
      matched,
    });
  }
  return {
    agentId: forecast.agentId,
    checks,
    matched: checks.length > 0 && checks.every((check) => check.matched),
  };
}

/**
 * Aggregates round-2 forecasts under the given condition.
 *
 * Baseline averages raw reported numbers with no format lookup — that is the
 * corrupted channel under probability-format drift. Addressed conditions
 * normalize each included forecast by that agent's own ProbabilityFormat
 * (from `agentRegistries`) before averaging.
 */
export async function aggregateForecasts(options: {
  forecasts: readonly ForecastObject[];
  condition: ForecastingCondition;
  canonicalRegistry: AgentRegistry;
  agentRegistries: ReadonlyMap<string, AgentRegistry>;
  referenceProvider: SemanticReferenceProvider;
}): Promise<AggregationResult> {
  const policy = conditionPolicy(options.condition);
  const verifications: AgentVerification[] = [];
  const included: ForecastObject[] = [];
  const excluded: ForecastObject[] = [];
  const exclusionReasons = new Map<string, string>();

  let referencesChecked = 0;
  let referencesMatched = 0;
  let referencesMismatched = 0;

  for (const forecast of options.forecasts) {
    if (!policy.verifies) {
      included.push(forecast);
      continue;
    }

    const verification = await verifyForecastReferences(
      forecast,
      options.canonicalRegistry,
      options.referenceProvider,
    );
    verifications.push(verification);
    referencesChecked += verification.checks.length;
    const matchedCount = verification.checks.filter((c) => c.matched).length;
    referencesMatched += matchedCount;
    referencesMismatched += verification.checks.length - matchedCount;

    if (policy.enforces && !verification.matched) {
      excluded.push(forecast);
      exclusionReasons.set(forecast.agentId, SEMANTIC_MISMATCH_REASON);
    } else {
      included.push(forecast);
    }
  }

  const driftDetected = referencesMismatched > 0;

  let aggregateProbability: number | null;
  const normalizedIncluded: number[] = [];

  if (!policy.verifies) {
    // Baseline: blind raw mean — no format normalization.
    aggregateProbability = meanProbability(
      included.map((forecast) => forecast.probability),
    );
    // Record raw values for diagnostics (not unit-normalized under baseline).
    for (const forecast of included) {
      normalizedIncluded.push(forecast.probability);
    }
  } else {
    for (const forecast of included) {
      const registry = options.agentRegistries.get(forecast.agentId);
      if (!registry) {
        throw new Error(`Missing registry for agent ${forecast.agentId}.`);
      }
      const format = registry.resolve("ProbabilityFormat");
      normalizedIncluded.push(
        normalizeProbability(forecast.probability, format),
      );
    }
    aggregateProbability = meanProbability(normalizedIncluded);
  }

  return {
    included,
    excluded,
    exclusionReasons,
    verifications,
    referencesChecked,
    referencesMatched,
    referencesMismatched,
    driftDetected,
    aggregateProbability,
    normalizedIncluded,
  };
}
