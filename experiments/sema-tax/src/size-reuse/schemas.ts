import {
  trialEventSchema,
  trialProvenanceSchema,
  transcriptSchema,
  usageTelemetrySchema,
} from "@sema-evals/core";
import { z } from "zod";

import { semaTaxPatternSchema, semaTaxScenarioSchema } from "../schemas.js";

/**
 * The size/reuse follow-up arm (ADR 0013). It holds pattern count fixed at p8
 * and delivery cold, and crosses two new orthogonal axes:
 *
 * - **size** in {small, medium, large}: how many bytes a definition carries.
 *   The scoreable core (comparator/threshold/unit) is byte-identical across
 *   tiers; only auxiliary specification content varies, and the scorer never
 *   reads it. Size isolates amortization-by-bytes.
 * - **reuse** R in {1, 3, 9}: a trial is R sequential worksheet messages in one
 *   conversation. Prose re-ships the definitions in every message; resolver arms
 *   ship compact references every message but hydrate the definitions once.
 *   Reuse isolates amortization-by-repetition.
 *
 * The grid is `3 sizes x 3 R x 3 delivery x cold = 27` conditions. The cache
 * axis is dropped per ADR 0011 (hydration is the controlled channel here).
 */
export const SEMA_TAX_SIZE_TIERS = ["small", "medium", "large"] as const;
export type SemaTaxSizeTier = (typeof SEMA_TAX_SIZE_TIERS)[number];

export const SEMA_TAX_REUSE_FACTORS = [1, 3, 9] as const;
export type SemaTaxReuseFactor = (typeof SEMA_TAX_REUSE_FACTORS)[number];

/** The three delivery arms carried forward from the base design. The baseline
 * (task-only) arm has nothing to size or reuse, so it is not part of this grid. */
export const SEMA_TAX_SIZE_REUSE_DELIVERIES = [
  "prose",
  "opaque",
  "content",
] as const;
export type SemaTaxSizeReuseDelivery =
  (typeof SEMA_TAX_SIZE_REUSE_DELIVERIES)[number];

/** Pattern count is fixed at the well-characterized mid-curve point. */
export const SEMA_TAX_SIZE_REUSE_PATTERN_COUNT = 8;

/**
 * Canonical target byte bands for the rendered tier definition (the definition
 * object serialized with the byte-stable serializer). Enforced by the fixture
 * loader and the fixture test. Small is the base ~100 B card and has no band.
 */
export const SEMA_TAX_TIER_BYTE_BANDS: Record<
  Exclude<SemaTaxSizeTier, "small">,
  { min: number; max: number }
> = {
  medium: { min: 900, max: 1200 },
  large: { min: 3500, max: 4500 },
};

/** Auxiliary specification content attached to a pattern at a size tier. These
 * fields carry bytes but never participate in scoring. */
export const semaTaxAuxiliarySchema = z.object({
  rationale: z.string().min(1),
  boundaryExamples: z.array(z.string().min(1)).min(1),
  edgeCaseNotes: z.string().min(1),
});

/** A pattern with the base scoreable core plus per-tier auxiliary content. The
 * `small` tier is the core alone, so no auxiliary is stored for it. */
export const semaTaxSizedPatternSchema = semaTaxPatternSchema.extend({
  auxiliary: z.object({
    medium: semaTaxAuxiliarySchema,
    large: semaTaxAuxiliarySchema,
  }),
});

export const semaTaxSizeReuseFixtureSetSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  patterns: z.array(semaTaxSizedPatternSchema).min(16),
  scenarios: z.array(semaTaxScenarioSchema).min(1),
});

export const semaTaxSizeReuseDeliverySchema = z.enum(
  SEMA_TAX_SIZE_REUSE_DELIVERIES,
);
export const semaTaxSizeTierSchema = z.enum(SEMA_TAX_SIZE_TIERS);
export const semaTaxModelCompletionStatusSchema = z.enum([
  "completed",
  "refused",
  "truncated",
  "error",
]);

/** Condition ids: `p{n}-{size}-r{R}-{delivery}-cold`. */
export const semaTaxSizeReuseConditionSchema = z
  .string()
  .regex(/^p(\d+)-(small|medium|large)-r(\d+)-(prose|opaque|content)-cold$/);

/**
 * Per-message telemetry for one worksheet message inside the R-message trial.
 * Wire and hydration bytes are recorded separately per message, so prose's
 * `wireBytes` (paid every message) and a resolver arm's one-time `hydrationBytes`
 * (message 0 only) are both directly visible.
 */
export const semaTaxMessageMetricsSchema = z.object({
  messageIndex: z.number().int().nonnegative(),
  wireBytes: z.number().int().nonnegative(),
  hydrationBytes: z.number().int().nonnegative(),
  totalContextBytes: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalModelTokens: z.number().int().nonnegative(),
  /** Provider call outcome and full telemetry; both null in deterministic mode. */
  completionStatus: semaTaxModelCompletionStatusSchema.nullable(),
  usage: usageTelemetrySchema.nullable(),
  itemsTotal: z.number().int().positive(),
  itemsAnswered: z.number().int().nonnegative(),
  itemsCorrect: z.number().int().nonnegative(),
  score: z.number().min(0).max(1),
  taskSuccess: z.boolean(),
});

/**
 * Trial-level rollup metrics. Cumulative wire/hydration/token channels sum over
 * the R messages; `score` is the mean per-message score and `itemsAnswered`/
 * `itemsCorrect` are summed. `totalSemanticBytes` (cumulative wire + hydration)
 * and `totalModelTokens` are the two primary-endpoint denominators.
 */
export const semaTaxSizeReuseMetricsSchema = z.object({
  patternCount: z.number().int().nonnegative(),
  size: semaTaxSizeTierSchema,
  reuse: z.number().int().positive(),
  delivery: semaTaxSizeReuseDeliverySchema,
  cacheState: z.literal("cold"),
  activePatternCount: z.number().int().nonnegative(),
  /** Per-message telemetry, one entry per reuse message (length == reuse). */
  messages: z.array(semaTaxMessageMetricsSchema).min(1),
  cumulativeWireBytes: z.number().int().nonnegative(),
  cumulativeHydrationBytes: z.number().int().nonnegative(),
  /** Primary byte denominator: cumulative wire + cumulative hydration. */
  totalSemanticBytes: z.number().int().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalCachedInputTokensRead: z.number().int().nonnegative(),
  totalCachedInputTokensWritten: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  /** Primary token denominator: summed billable model tokens across messages. */
  totalModelTokens: z.number().int().nonnegative(),
  itemsTotal: z.number().int().positive(),
  itemsAnswered: z.number().int().nonnegative(),
  itemsCorrect: z.number().int().nonnegative(),
  /** Mean per-message worksheet score in [0, 1]. */
  score: z.number().min(0).max(1),
  /** Binary success: every message fully correct. */
  taskSuccess: z.boolean(),
  modelFailureMessages: z.number().int().nonnegative(),
  totalAttempts: z.number().int().nonnegative(),
  totalRetries: z.number().int().nonnegative(),
  totalProviderErrors: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  elapsedMs: z.number().nonnegative(),
});

export const semaTaxSizeReuseTrialRecordSchema = z.object({
  trialId: z.string().length(64),
  experimentId: z.string().min(1),
  scenarioId: z.string().min(1),
  condition: semaTaxSizeReuseConditionSchema,
  seed: z.number().int().nonnegative(),
  executionIndex: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  events: z.array(trialEventSchema),
  metrics: semaTaxSizeReuseMetricsSchema,
  provenance: trialProvenanceSchema,
  usage: usageTelemetrySchema.nullable(),
  transcript: transcriptSchema.nullable(),
});

export const semaTaxSizeReuseResultManifestSchema = z.object({
  artifactSchemaVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  experimentId: z.string().min(1),
  runId: z.string().min(1),
  arm: z.literal("size-reuse"),
  mode: z.enum(["deterministic-harness", "model-pilot", "confirmatory"]),
  evidenceClaim: z.string().min(1),
  createdAt: z.string().datetime(),
  orderSeed: z.number().int().nonnegative(),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  conditions: z.array(semaTaxSizeReuseConditionSchema).min(1),
  patternCount: z.number().int().positive(),
  sizes: z.array(semaTaxSizeTierSchema).min(1),
  reuseFactors: z.array(z.number().int().positive()).min(1),
  scenarioCount: z.number().int().positive(),
  trialCount: z.number().int().positive(),
  fixtureDigest: z.string().length(64),
  scorer: z
    .object({
      version: z.string().min(1),
      fingerprint: z.string().length(64),
    })
    .optional(),
  protocolFingerprint: z.string().length(64).optional(),
  runConfiguration: z
    .object({
      arm: z.literal("size-reuse"),
      provider: z.string().min(1),
      model: z.string().min(1),
      seeds: z.array(z.number().int().nonnegative()).min(1),
      concurrency: z.number().int().positive(),
      maxTokens: z.number().int().positive().nullable(),
      semanticBackend: z.string().min(1),
      thinking: z.string().min(1).nullable(),
      endpointHost: z.string().nullable(),
      harness: z.record(z.string(), z.string()).nullable().optional(),
      orderSeed: z.number().int().nonnegative(),
    })
    .optional(),
  provenance: trialProvenanceSchema,
});

export type SemaTaxAuxiliary = z.infer<typeof semaTaxAuxiliarySchema>;
export type SemaTaxSizedPattern = z.infer<typeof semaTaxSizedPatternSchema>;
export type SemaTaxSizeReuseFixtureSet = z.infer<
  typeof semaTaxSizeReuseFixtureSetSchema
>;
export type SemaTaxMessageMetrics = z.infer<typeof semaTaxMessageMetricsSchema>;
export type SemaTaxSizeReuseMetrics = z.infer<
  typeof semaTaxSizeReuseMetricsSchema
>;
export type SemaTaxSizeReuseTrialRecord = z.infer<
  typeof semaTaxSizeReuseTrialRecordSchema
>;
export type SemaTaxSizeReuseResultManifest = z.infer<
  typeof semaTaxSizeReuseResultManifestSchema
>;
