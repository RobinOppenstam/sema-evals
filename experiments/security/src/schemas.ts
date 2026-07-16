import {
  trialEventSchema,
  trialProvenanceSchema,
  transcriptSchema,
  usageTelemetrySchema,
} from "@sema-evals/core";
import { z } from "zod";

/**
 * Security domain trials (RESEARCH_PLAN Phase 4).
 *
 * Primary endpoint: vulnerability recall at a fixed false-positive budget on
 * mutation-backed Solidity cases, with train/heldout separation and no heldout
 * knowledge in Pattern Cards (see ADR 0014).
 */

export const VULNERABILITY_CLASSES = [
  "reentrancy",
  "access-control",
  "unchecked-external-call",
] as const;

export const vulnerabilityClassSchema = z.enum(VULNERABILITY_CLASSES);

export const CASE_SPLITS = ["train", "heldout"] as const;
export const caseSplitSchema = z.enum(CASE_SPLITS);

export const SECURITY_CONDITIONS = [
  "baseline",
  "equal-prose",
  "addressed-voluntary",
  "addressed-enforced",
] as const;

export const securityConditionSchema = z.enum(SECURITY_CONDITIONS);

/** One ground-truth finding the scorer expects on the vulnerable variant. */
export const expectedFindingSchema = z.object({
  class: vulnerabilityClassSchema,
  function: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
});

/**
 * Distinguishing mutation metadata. Integrity tests use the markers to confirm
 * vulnerable.sol and patched.sol differ in the described way; the free-text
 * description is for humans and future model prompts.
 */
export const mutationSchema = z.object({
  description: z.string().min(1),
  /** Substring that must appear in vulnerable.sol and not in patched.sol. */
  vulnerableMarker: z.string().min(1),
  /** Substring that must appear in patched.sol and not in vulnerable.sol. */
  patchedMarker: z.string().min(1),
});

export const securityCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  class: vulnerabilityClassSchema,
  title: z.string().min(1),
  split: caseSplitSchema,
  mutation: mutationSchema,
  expectedFindings: z.array(expectedFindingSchema).min(1),
  /** Solidity identifiers used by the leakage guard (heldout-only names). */
  identifiers: z.object({
    contractName: z.string().min(1),
    functions: z.array(z.string().min(1)).min(1),
    variables: z.array(z.string().min(1)).default([]),
  }),
  solc: z.literal("^0.8.0"),
});

export const securityFixtureCatalogSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  cases: z.array(securityCaseSchema).min(1),
});

/**
 * A `sema-sec` Pattern Card. Content must be derivable from the train split
 * only; the leakage guard enforces that heldout-unique identifiers never appear
 * in any card text.
 */
export const patternCardSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  class: vulnerabilityClassSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  checklist: z.array(z.string().min(1)).min(1),
});

export const patternCardSetSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  vocabulary: z.literal("sema-sec"),
  cards: z.array(patternCardSchema).min(1),
});

/**
 * Canned auditor outputs for instrumentation mode. Keyed by
 * `${caseId}::${condition}` so every matrix cell has an explicit scripted
 * response. Unparseable entries are preserved as failures by the scorer.
 */
export const cannedFindingsSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  entries: z.record(z.string(), z.string()),
});

export const securityMetricsSchema = z.object({
  split: caseSplitSchema,
  vulnerabilityClass: vulnerabilityClassSchema,
  parseFailure: z.boolean(),
  enforcementRefused: z.boolean(),
  expectedCount: z.number().int().nonnegative(),
  truePositives: z.number().int().nonnegative(),
  falsePositives: z.number().int().nonnegative(),
  falseNegatives: z.number().int().nonnegative(),
  /** Per-trial recall = TP / (TP + FN); 0 when parseFailure or no expected. */
  recall: z.number().min(0).max(1),
  /** Whether this trial's FP count is within the configured per-case budget. */
  withinFpBudget: z.boolean(),
  fpBudget: z.number().int().nonnegative(),
  wireBytes: z.number().int().nonnegative(),
  hydrationBytes: z.number().int().nonnegative(),
  totalSemanticBytes: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});

export const securityTrialRecordSchema = z.object({
  trialId: z.string().length(64),
  experimentId: z.string().min(1),
  scenarioId: z.string().min(1),
  condition: securityConditionSchema,
  seed: z.number().int().nonnegative(),
  executionIndex: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  events: z.array(trialEventSchema),
  metrics: securityMetricsSchema,
  provenance: trialProvenanceSchema,
  usage: usageTelemetrySchema.nullable(),
  transcript: transcriptSchema.nullable(),
  /** Raw auditor text preserved for every trial, including parse failures. */
  auditorOutput: z.string(),
});

export const securityResultManifestSchema = z.object({
  artifactSchemaVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  experimentId: z.string().min(1),
  runId: z.string().min(1),
  mode: z.enum(["instrumentation", "deterministic-harness", "model-pilot"]),
  evidenceClaim: z.string().min(1),
  createdAt: z.string().datetime(),
  orderSeed: z.number().int().nonnegative(),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  conditions: z.array(securityConditionSchema).min(1),
  scenarioCount: z.number().int().positive(),
  trainCaseCount: z.number().int().nonnegative(),
  heldoutCaseCount: z.number().int().nonnegative(),
  trialCount: z.number().int().positive(),
  fpBudget: z.number().int().nonnegative(),
  scorerVersion: z.string().min(1),
  fixtureDigest: z.string().length(64),
  provenance: trialProvenanceSchema,
  withFoundry: z.boolean(),
  foundryAvailable: z.boolean(),
});

export type VulnerabilityClass = z.infer<typeof vulnerabilityClassSchema>;
export type CaseSplit = z.infer<typeof caseSplitSchema>;
export type SecurityCondition = z.infer<typeof securityConditionSchema>;
export type ExpectedFinding = z.infer<typeof expectedFindingSchema>;
export type Mutation = z.infer<typeof mutationSchema>;
export type SecurityCase = z.infer<typeof securityCaseSchema>;
export type SecurityFixtureCatalog = z.infer<
  typeof securityFixtureCatalogSchema
>;
export type PatternCard = z.infer<typeof patternCardSchema>;
export type PatternCardSet = z.infer<typeof patternCardSetSchema>;
export type CannedFindings = z.infer<typeof cannedFindingsSchema>;
export type SecurityMetrics = z.infer<typeof securityMetricsSchema>;
export type SecurityTrialRecord = z.infer<typeof securityTrialRecordSchema>;
export type SecurityResultManifest = z.infer<
  typeof securityResultManifestSchema
>;

/** A loaded case with its on-disk Solidity sources. */
export interface LoadedSecurityCase {
  meta: SecurityCase;
  vulnerableSource: string;
  patchedSource: string;
  directory: string;
}
