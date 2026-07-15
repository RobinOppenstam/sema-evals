import {
  trialEventSchema,
  trialProvenanceSchema,
  transcriptSchema,
  usageTelemetrySchema,
} from "@sema-evals/core";
import { z } from "zod";

/**
 * A worksheet pattern: a compact, self-contained semantic card whose meaning is
 * a numeric comparison. Ground truth for any item bound to this pattern is
 * `value <comparator> threshold`, so the scorer is executable — no LLM judge.
 */
export const SEMA_TAX_COMPARATORS = [">=", ">", "<=", "<", "=="] as const;
export const semaTaxComparatorSchema = z.enum(SEMA_TAX_COMPARATORS);

export const semaTaxPatternSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  gloss: z.string().min(1),
  comparator: semaTaxComparatorSchema,
  threshold: z.number(),
  unit: z.string().min(1),
});

export const semaTaxItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  patternHandle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  value: z.number(),
});

export const semaTaxScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  prompt: z.string().min(1),
  /** Pattern handles in priority order. The active set for pattern count N is
   * the first N entries, so this must list at least the largest studied count
   * (16). */
  patternPool: z.array(z.string()).min(16),
  items: z.array(semaTaxItemSchema).min(1),
});

export const semaTaxFixtureSetSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  patterns: z.array(semaTaxPatternSchema).min(16),
  scenarios: z.array(semaTaxScenarioSchema).min(1),
});

/** Condition ids: the shared `p0-baseline` anchor, or `p{n}-{delivery}-{cache}`. */
export const semaTaxConditionSchema = z
  .string()
  .regex(/^p(\d+)-(?:baseline|(?:prose|opaque|content)-(?:cold|warm))$/);

export const semaTaxDeliverySchema = z.enum([
  "baseline",
  "prose",
  "opaque",
  "content",
]);
export const semaTaxCacheStateSchema = z.enum(["none", "cold", "warm"]);

/**
 * Per-trial measurements. Wire and hydration bytes are recorded separately, as
 * is the split between fresh and cached input tokens, so the tax curve can
 * report every cost channel independently (RESEARCH_PLAN Phase 2 exit gate).
 */
export const semaTaxMetricsSchema = z.object({
  patternCount: z.number().int().nonnegative(),
  delivery: semaTaxDeliverySchema,
  cacheState: semaTaxCacheStateSchema,
  activePatternCount: z.number().int().nonnegative(),
  itemsTotal: z.number().int().positive(),
  /** Items that received a parseable `ITEM <id>: yes|no` line (format
   * compliance), separate from correctness. Unanswered = itemsTotal - itemsAnswered.
   * itemsCorrect <= itemsAnswered always holds. */
  itemsAnswered: z.number().int().nonnegative(),
  itemsCorrect: z.number().int().nonnegative(),
  /** Graded quality in [0, 1]: fraction of worksheet items answered correctly. */
  score: z.number().min(0).max(1),
  /** Binary success: every item correct. */
  taskSuccess: z.boolean(),
  wireBytes: z.number().int().nonnegative(),
  hydrationBytes: z.number().int().nonnegative(),
  totalContextBytes: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokensRead: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  /** Billable model tokens: fresh input + output. Cached reads are cheaper and
   * counted separately, so this is the denominator of the primary endpoint. */
  totalModelTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  elapsedMs: z.number().nonnegative(),
});

export const semaTaxTrialRecordSchema = z.object({
  trialId: z.string().length(64),
  experimentId: z.string().min(1),
  scenarioId: z.string().min(1),
  condition: semaTaxConditionSchema,
  seed: z.number().int().nonnegative(),
  executionIndex: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  events: z.array(trialEventSchema),
  metrics: semaTaxMetricsSchema,
  provenance: trialProvenanceSchema,
  usage: usageTelemetrySchema.nullable(),
  transcript: transcriptSchema.nullable(),
});

export const semaTaxResultManifestSchema = z.object({
  artifactSchemaVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  experimentId: z.string().min(1),
  runId: z.string().min(1),
  mode: z.enum(["deterministic-harness", "model-pilot", "confirmatory"]),
  evidenceClaim: z.string().min(1),
  createdAt: z.string().datetime(),
  orderSeed: z.number().int().nonnegative(),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  conditions: z.array(semaTaxConditionSchema).min(1),
  patternCounts: z.array(z.number().int().nonnegative()).min(1),
  scenarioCount: z.number().int().positive(),
  trialCount: z.number().int().positive(),
  fixtureDigest: z.string().length(64),
  provenance: trialProvenanceSchema,
});

export type SemaTaxComparator = z.infer<typeof semaTaxComparatorSchema>;
export type SemaTaxPattern = z.infer<typeof semaTaxPatternSchema>;
export type SemaTaxItem = z.infer<typeof semaTaxItemSchema>;
export type SemaTaxScenario = z.infer<typeof semaTaxScenarioSchema>;
export type SemaTaxFixtureSet = z.infer<typeof semaTaxFixtureSetSchema>;
export type SemaTaxMetrics = z.infer<typeof semaTaxMetricsSchema>;
export type SemaTaxTrialRecord = z.infer<typeof semaTaxTrialRecordSchema>;
export type SemaTaxResultManifest = z.infer<typeof semaTaxResultManifestSchema>;
