import {
  trialEventSchema,
  trialProvenanceSchema,
  transcriptSchema,
  usageTelemetrySchema,
} from "@sema-evals/core";
import { z } from "zod";

/**
 * Forecasting council experiment (RESEARCH_PLAN Phase 5 scaffold).
 *
 * A council of scripted forecasters first forecasts independently, then
 * exchanges structured forecast objects and revises. Sema aligns the
 * coordination substrate (resolution definition, evidence cutoff, probability
 * format, aggregation rule) — never beliefs or point estimates. See ADR 0017.
 *
 * Deterministic harness only: synthetic Polymarket-style questions, scripted
 * agents, no live models, no network.
 */

/** The four coordination handles this experiment binds. */
export const COORDINATION_HANDLES = [
  "ResolutionDefinition",
  "EvidenceCutoff",
  "ProbabilityFormat",
  "AggregationRule",
] as const;

export const coordinationHandleSchema = z.enum(COORDINATION_HANDLES);

/** Typed failure reason when enforcement excludes a mismatched forecast. */
export const SEMANTIC_MISMATCH_REASON = "semantic-reference-mismatch";

/* -------------------------------------------------------------------------- */
/* Semantic references                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A content-addressed semantic reference for one coordination handle: the full
 * reference string, its digest, and the canonicalization version that produced
 * it. Same shape as a2a-drift / x402-contract-drift.
 */
export const semanticReferenceSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  ref: z.string().min(1),
  digest: z.string().length(64),
  canonicalizationVersion: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* Polymarket-style question (synthetic for this scaffold)                     */
/* -------------------------------------------------------------------------- */

export const resolvedOutcomeSchema = z.enum(["YES", "NO"]);

/** A frozen, locally retained evidence item used by a historical replay. */
export const evidenceItemSchema = z.object({
  id: z.string().min(1),
  sourceName: z.string().min(1),
  sourceUrl: z.string().url(),
  license: z.string().min(1),
  publishedAt: z.string().datetime(),
  retrievedAt: z.string().datetime(),
  frozenPath: z.string().min(1),
  sha256: z.string().length(64),
  summary: z.string().min(1),
});

export const evidencePackSchema = z.object({
  schemaVersion: z.literal("forecasting-evidence-pack-v1"),
  cutoff: z.string().datetime(),
  items: z.array(evidenceItemSchema).min(1),
});

/** Source and licence metadata for a resolved historical market question. */
export const historicalQuestionProvenanceSchema = z.object({
  datasetKind: z.literal("historical-resolved"),
  marketSourceName: z.string().min(1),
  marketSourceUrl: z.string().url(),
  marketLicense: z.string().min(1),
  acquiredAt: z.string().datetime(),
  resolutionSourceUrl: z.string().url(),
  resolutionLicense: z.string().min(1),
  resolutionVerifiedAt: z.string().datetime(),
  marketPriorObservedAt: z.string().datetime(),
  /** The last instant of information a forecaster may use. */
  forecastCutoff: z.string().datetime(),
  /** Terms/source snapshots and explicit authorization are required because trial records retain raw question text. */
  marketTermsSnapshotSha256: z.string().length(64),
  resolutionTermsSnapshotSha256: z.string().length(64),
  publicationRedistributionAuthorized: z.literal(true),
});

/**
 * A resolved Polymarket-style market question. For this deterministic scaffold
 * every fixture is synthetic (invented events); real Polymarket sourcing is
 * future work (ADR 0017).
 *
 * `evidencePack` is the extension point for a follow-up evidence-pack arm; it
 * is null throughout this scaffold (no-evidence variant first).
 */
export const forecastingQuestionSchema = z.object({
  questionText: z.string().min(1),
  /** Precise resolution criteria — agent-facing; never annotated with ground truth. */
  resolutionCriteria: z.string().min(1),
  resolutionTimestamp: z.string().datetime(),
  resolvedOutcome: resolvedOutcomeSchema,
  /**
   * Latest available market price at or before `forecastCutoff`, in [0, 1] —
   * the market-prior Brier baseline from the research plan.
   */
  marketPrior: z.number().min(0).max(1),
  /**
   * Extension point for hand-curated evidence packs (follow-up arm). Null
   * throughout this no-evidence-first scaffold.
   */
  evidencePack: evidencePackSchema.nullable(),
  /** Null for synthetic deterministic fixtures; mandatory for model pilots. */
  historicalProvenance: historicalQuestionProvenanceSchema
    .nullable()
    .optional(),
});

/* -------------------------------------------------------------------------- */
/* Leakage audit                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Per-question leakage audit entry. The exploratory pilot exit gate requires
 * every included question to carry an audit with verdict `keep`. Synthetic
 * fixtures supply these for the deterministic demo.
 */
export const leakageAuditEntrySchema = z.object({
  model: z.string().min(1),
  zeroEvidenceAnswer: resolvedOutcomeSchema,
  confidence: z.number().min(0).max(1),
  verdict: z.enum(["keep", "drop"]),
  /** Required for a model-pilot audit, optional for synthetic fixtures. */
  modelDescriptor: z.string().min(1).optional(),
  promptFingerprint: z.string().length(64).optional(),
  auditedAt: z.string().datetime().optional(),
  evidenceExcluded: z.literal(true).optional(),
  rawOutput: z.string().optional(),
  modelRevision: z.string().min(1).optional(),
  trainingCutoff: z.string().min(1).optional(),
  reviewer: z.string().min(1).optional(),
  rationale: z.string().min(1).optional(),
  transcript: transcriptSchema.optional(),
});

export const leakageAuditDocumentSchema = z.object({
  schemaVersion: z.union([
    z.literal("0.1.0"),
    z.literal("forecasting-model-leakage-audit-v1"),
  ]),
  modelDescriptor: z.string().min(1).optional(),
  datasetDigest: z.string().length(64).optional(),
  protocolFingerprint: z.string().length(64).optional(),
  zeroEvidencePrompt: z.string().min(1).optional(),
  entries: z.array(
    z.object({
      scenarioId: z.string().min(1),
      audit: leakageAuditEntrySchema,
    }),
  ),
});

/* -------------------------------------------------------------------------- */
/* Forecast objects                                                            */
/* -------------------------------------------------------------------------- */

export const forecastRoundSchema = z.union([z.literal(1), z.literal(2)]);

/**
 * A structured forecast object exchanged in the council. Under baseline,
 * `citedReferences` is empty and `citedHandles` names the coordination terms.
 * Under addressed conditions, `citedReferences` carries content-addressed
 * refs computed from the agent's own registry.
 */
export const forecastObjectSchema = z.object({
  agentId: z.string().min(1),
  round: forecastRoundSchema,
  /** Probability as reported in the agent's ProbabilityFormat. */
  probability: z.number(),
  citedHandles: z.array(z.string().regex(/^[A-Z][A-Za-z0-9]*$/)),
  citedReferences: z.array(semanticReferenceSchema),
});

/* -------------------------------------------------------------------------- */
/* Conditions                                                                  */
/* -------------------------------------------------------------------------- */

export const FORECASTING_CONDITIONS = [
  "baseline",
  "addressed-voluntary",
  "addressed-enforced",
] as const;

export const forecastingConditionSchema = z.enum(FORECASTING_CONDITIONS);

/* -------------------------------------------------------------------------- */
/* Experiment record shapes                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Per-trial measurements. Primary endpoint: corrupted aggregation under drift
 * (a drifted forecast entered the aggregate with no surfaced mismatch).
 * Secondary: false exclusions on no-drift controls. Brier scores for the
 * council aggregate, market prior, and independent-agent average are recorded
 * on every trial.
 */
export const forecastingMetricsSchema = z.object({
  driftInjected: z.boolean(),
  referencesCarried: z.boolean(),
  verificationPerformed: z.boolean(),
  referencesChecked: z.number().int().nonnegative(),
  referencesMatched: z.number().int().nonnegative(),
  referencesMismatched: z.number().int().nonnegative(),
  driftDetected: z.boolean(),
  forecastsSubmitted: z.number().int().nonnegative(),
  forecastsIncluded: z.number().int().nonnegative(),
  forecastsExcluded: z.number().int().nonnegative(),
  /** The drifted agent's forecast entered the aggregate. */
  driftedForecastIncluded: z.boolean(),
  /** Primary endpoint: drift injected, drifted forecast included, no mismatch surfaced. */
  corruptedAggregation: z.boolean(),
  correctExclusion: z.boolean(),
  /** Secondary endpoint: exclusion on a no-drift control. */
  falseExclusion: z.boolean(),
  /** Raw council aggregate under canonical interpretation; null if none included. */
  aggregateProbability: z.number().nullable(),
  marketPrior: z.number().min(0).max(1),
  /**
   * Round-1 simple average over drift-free members (mandatory independent-agent
   * baseline from the research plan).
   */
  independentAverage: z.number().min(0).max(1).nullable(),
  /** Null when no aggregate exists or the aggregate is outside [0, 1]. */
  brierAggregate: z.number().nonnegative().nullable(),
  brierMarketPrior: z.number().nonnegative(),
  brierIndependentAverage: z.number().nonnegative().nullable(),
  outcome: resolvedOutcomeSchema,
  exclusionReasons: z.array(z.string()),
  wireBytes: z.number().int().nonnegative(),
  hydrationBytes: z.number().int().nonnegative(),
  totalSemanticBytes: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});

export const forecastingTrialRecordSchema = z.object({
  trialId: z.string().length(64),
  experimentId: z.string().min(1),
  scenarioId: z.string().min(1),
  condition: forecastingConditionSchema,
  seed: z.number().int().nonnegative(),
  executionIndex: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  driftInjected: z.boolean(),
  question: forecastingQuestionSchema,
  leakageAudit: leakageAuditEntrySchema,
  round1Forecasts: z.array(forecastObjectSchema),
  round2Forecasts: z.array(forecastObjectSchema),
  includedAgentIds: z.array(z.string()),
  excludedAgentIds: z.array(z.string()),
  events: z.array(trialEventSchema),
  metrics: forecastingMetricsSchema,
  provenance: trialProvenanceSchema,
  usage: usageTelemetrySchema.nullable(),
  transcript: transcriptSchema.nullable(),
});

export const forecastingResultManifestSchema = z.object({
  artifactSchemaVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  experimentId: z.string().min(1),
  runId: z.string().min(1),
  mode: z.enum(["deterministic-harness", "model-pilot", "confirmatory"]),
  evidenceClaim: z.string().min(1),
  createdAt: z.string().datetime(),
  orderSeed: z.number().int().nonnegative(),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  conditions: z.array(forecastingConditionSchema).min(1),
  scenarioCount: z.number().int().positive(),
  driftScenarioCount: z.number().int().nonnegative(),
  cleanScenarioCount: z.number().int().nonnegative(),
  trialCount: z.number().int().positive(),
  fixtureDigest: z.string().length(64),
  leakageAuditPassed: z.boolean(),
  scorer: z.object({
    version: z.string().min(1),
    fingerprint: z.string().length(64),
  }),
  protocolFingerprint: z.string().length(64),
  runConfiguration: z.object({
    mode: z.enum(["deterministic-harness", "model-pilot"]),
    seeds: z.array(z.number().int().nonnegative()).min(1),
    orderSeed: z.number().int().nonnegative(),
    semanticBackend: z.enum(["fixture", "sema-python"]),
    policy: z.string().min(1),
    aggregationInterpretation: z.literal("canonical-probability-format"),
    datasetDigest: z.string().length(64).nullable().optional(),
    leakageAuditFingerprint: z.string().length(64).nullable().optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    endpointHost: z.string().nullable().optional(),
  }),
  provenance: trialProvenanceSchema,
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

export const semanticDefinitionSchema = z.record(z.string(), z.unknown());

export const registeredPatternSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  definition: semanticDefinitionSchema,
});

export const scriptedAgentSchema = z.object({
  id: z.string().min(1),
  /** Round-1 independent forecast, in the agent's ProbabilityFormat. */
  round1Probability: z.number(),
  /** Round-2 revised forecast after seeing peers, in the agent's ProbabilityFormat. */
  round2Probability: z.number(),
});

export const scenarioDriftSchema = z.object({
  /** The single agent whose registry has drifted. */
  agentId: z.string().min(1),
  /** The single handle whose definition that agent holds mutated. */
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  fieldPath: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
  mutatedDefinition: semanticDefinitionSchema,
});

export const forecastingScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    description: z.string().min(1),
    question: forecastingQuestionSchema,
    leakageAudit: leakageAuditEntrySchema,
    /** Canonical registry contents shared by all agents before drift. */
    patterns: z.array(registeredPatternSchema).min(1),
    /** Handles each forecast must cite. Subset of `patterns`. */
    coordinationHandles: z
      .array(z.string().regex(/^[A-Z][A-Za-z0-9]*$/))
      .min(1),
    agents: z.array(scriptedAgentSchema).min(2),
    /** Per-agent registry drift, or `null` for a no-drift control. */
    drift: scenarioDriftSchema.nullable(),
  })
  .superRefine((scenario, context) => {
    const defined = new Set(scenario.patterns.map((p) => p.handle));
    if (defined.size !== scenario.patterns.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Scenario pattern handles must be unique.",
        path: ["patterns"],
      });
    }
    for (const handle of scenario.coordinationHandles) {
      if (!defined.has(handle)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Coordination handle ${handle} is not a registered pattern.`,
          path: ["coordinationHandles"],
        });
      }
    }
    const agentIds = new Set(scenario.agents.map((a) => a.id));
    if (agentIds.size !== scenario.agents.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Scenario agent ids must be unique.",
        path: ["agents"],
      });
    }
    if (scenario.drift) {
      if (!agentIds.has(scenario.drift.agentId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Drift agentId ${scenario.drift.agentId} is not a council member.`,
          path: ["drift", "agentId"],
        });
      }
      if (!defined.has(scenario.drift.handle)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Drift handle ${scenario.drift.handle} is not a registered pattern.`,
          path: ["drift", "handle"],
        });
      }
      if (!scenario.coordinationHandles.includes(scenario.drift.handle)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Drift handle ${scenario.drift.handle} must be in coordinationHandles.`,
          path: ["drift", "handle"],
        });
      }
    }
  });

export const forecastingFixtureSetSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  scenarios: z.array(forecastingScenarioSchema).min(1),
});

/**
 * Model-pilot input. It deliberately reuses the normal scenarios so the
 * primary endpoint, conditions, and mandatory baselines cannot disappear in a
 * live run. Scripted probabilities are retained only for deterministic mode.
 */
export const historicalForecastingDatasetSchema = z.object({
  schemaVersion: z.literal("forecasting-historical-dataset-v1"),
  licenseNotice: z.string().min(1),
  scenarios: z.array(forecastingScenarioSchema).min(1),
});

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type CoordinationHandle = z.infer<typeof coordinationHandleSchema>;
export type SemanticReference = z.infer<typeof semanticReferenceSchema>;
export type ResolvedOutcome = z.infer<typeof resolvedOutcomeSchema>;
export type ForecastingQuestion = z.infer<typeof forecastingQuestionSchema>;
export type LeakageAuditEntry = z.infer<typeof leakageAuditEntrySchema>;
export type LeakageAuditDocument = z.infer<typeof leakageAuditDocumentSchema>;
export type ForecastObject = z.infer<typeof forecastObjectSchema>;
export type ForecastingCondition = z.infer<typeof forecastingConditionSchema>;
export type ForecastingMetrics = z.infer<typeof forecastingMetricsSchema>;
export type ForecastingTrialRecord = z.infer<
  typeof forecastingTrialRecordSchema
>;
export type ForecastingResultManifest = z.infer<
  typeof forecastingResultManifestSchema
>;
export type RegisteredPattern = z.infer<typeof registeredPatternSchema>;
export type ScriptedAgent = z.infer<typeof scriptedAgentSchema>;
export type ScenarioDrift = z.infer<typeof scenarioDriftSchema>;
export type ForecastingScenario = z.infer<typeof forecastingScenarioSchema>;
export type ForecastingFixtureSet = z.infer<typeof forecastingFixtureSetSchema>;
export type EvidencePack = z.infer<typeof evidencePackSchema>;
export type HistoricalQuestionProvenance = z.infer<
  typeof historicalQuestionProvenanceSchema
>;
export type HistoricalForecastingDataset = z.infer<
  typeof historicalForecastingDatasetSchema
>;
