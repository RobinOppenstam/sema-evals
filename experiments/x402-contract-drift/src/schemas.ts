import {
  trialEventSchema,
  trialProvenanceSchema,
  transcriptSchema,
  usageTelemetrySchema,
} from "@sema-evals/core";
import { z } from "zod";

/**
 * x402 payment-contract drift experiment (RESEARCH_PLAN parallel track).
 *
 * The x402 wire shapes below are modelled faithfully in-repo as typed zod
 * schemas rather than taken from an external SDK: determinism and
 * dependency-lightness win, and real-SDK conformance is future work (see ADR
 * 0016). These are in-repo models of the x402 v1 shapes, not conformance
 * artifacts. The Sema semantic extension rides ENTIRELY inside x402's own
 * `PaymentRequirements.extra` field — so no core x402 field is ever
 * repurposed.
 */

/** The canonicalization/vocabulary-root extension this experiment advertises. */
export const SEMANTIC_EXTENSION_URI =
  "https://sema-evals.dev/x402/ext/semantic-canonicalization/v0.1";

/** x402 protocol version modelled by these shapes (v1 field names). */
export const X402_PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* x402 PaymentRequirements (402 accepts[])                                    */
/* -------------------------------------------------------------------------- */

/**
 * A content-addressed semantic reference for one payment-term handle: the full
 * reference string, its digest, and the canonicalization version that produced
 * it. Same shape as a2a-drift.
 */
export const semanticReferenceSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  ref: z.string().min(1),
  digest: z.string().length(64),
  canonicalizationVersion: z.string().min(1),
});

/**
 * The acceptance contract the seller attaches in `PaymentRequirements.extra`.
 * It names the payment-term handles the payer must honor, binds each to a
 * required content-addressed reference, and declares whether the binding is
 * enforced (fail-closed: refuse to emit PaymentPayload) or voluntary.
 */
export const acceptanceContractSchema = z.object({
  contractId: z.string().min(1),
  extensionUri: z.literal(SEMANTIC_EXTENSION_URI),
  enforcement: z.enum(["voluntary", "enforced"]),
  requiredReferences: z.array(semanticReferenceSchema).min(1),
});

/**
 * One x402 `PaymentRequirements` object as it appears in a 402 `accepts[]`
 * array. Core fields match the v1 spec; `extra` is the sole extension point
 * and carries the acceptance contract when advertised (omitted entirely under
 * baseline).
 */
export const paymentRequirementsSchema = z.object({
  scheme: z.string().min(1),
  network: z.string().min(1),
  maxAmountRequired: z.string().min(1),
  asset: z.string().min(1),
  payTo: z.string().min(1),
  resource: z.string().min(1),
  description: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  outputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: acceptanceContractSchema.optional(),
});

/** The 402 payment-required envelope. */
export const paymentRequirementsResponseSchema = z.object({
  x402Version: z.literal(X402_PROTOCOL_VERSION),
  error: z.string().min(1),
  accepts: z.array(paymentRequirementsSchema).min(1),
});

/* -------------------------------------------------------------------------- */
/* x402 PaymentPayload (X-PAYMENT content) + SettlementResponse                */
/* -------------------------------------------------------------------------- */

/**
 * Scheme-specific payload. Signing is simulated deterministically — no real
 * crypto libraries and no chain interaction (ADR 0016).
 */
export const schemePayloadSchema = z.object({
  signature: z.string().min(1),
  authorization: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    value: z.string().min(1),
    validAfter: z.string().min(1),
    validBefore: z.string().min(1),
    nonce: z.string().min(1),
  }),
});

export const paymentPayloadSchema = z.object({
  x402Version: z.literal(X402_PROTOCOL_VERSION),
  scheme: z.string().min(1),
  network: z.string().min(1),
  payload: schemePayloadSchema,
});

export const settlementResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  transaction: z.string().optional(),
  network: z.string().optional(),
  payer: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Terminal payment state                                                      */
/* -------------------------------------------------------------------------- */

export const paymentStateSchema = z.enum(["paid", "refused"]);

/* -------------------------------------------------------------------------- */
/* Experiment record shapes                                                    */
/* -------------------------------------------------------------------------- */

export const X402_DRIFT_CONDITIONS = [
  "baseline",
  "advertised-voluntary",
  "advertised-enforced",
] as const;

export const x402DriftConditionSchema = z.enum(X402_DRIFT_CONDITIONS);

/**
 * Per-trial measurements. The primary endpoint is `silentPayment`: the payer
 * paid under a drifted definition with no surfaced mismatch. `driftDetected`,
 * `paid`, and `halted` are decomposed so voluntary detection (detected, paid)
 * is distinguishable from enforced refusal (detected AND halted).
 */
export const x402DriftMetricsSchema = z.object({
  driftInjected: z.boolean(),
  extensionAdvertised: z.boolean(),
  referencesCarried: z.boolean(),
  verificationPerformed: z.boolean(),
  referencesChecked: z.number().int().nonnegative(),
  referencesMatched: z.number().int().nonnegative(),
  referencesMismatched: z.number().int().nonnegative(),
  driftDetected: z.boolean(),
  paid: z.boolean(),
  halted: z.boolean(),
  /** Primary endpoint: drift injected, payment emitted, mismatch never surfaced. */
  silentPayment: z.boolean(),
  correctHalt: z.boolean(),
  falseHalt: z.boolean(),
  /** Reached the safety-correct terminal state for its (scenario, condition). */
  taskSuccess: z.boolean(),
  finalPaymentState: paymentStateSchema,
  failureReason: z.string().nullable(),
  wireBytes: z.number().int().nonnegative(),
  hydrationBytes: z.number().int().nonnegative(),
  totalSemanticBytes: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});

export const x402DriftTrialRecordSchema = z.object({
  trialId: z.string().length(64),
  experimentId: z.string().min(1),
  scenarioId: z.string().min(1),
  condition: x402DriftConditionSchema,
  seed: z.number().int().nonnegative(),
  executionIndex: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  driftInjected: z.boolean(),
  finalPaymentState: paymentStateSchema,
  /** Captured 402 requirements (extension present or absent is evidence). */
  paymentRequirements: paymentRequirementsSchema,
  /** Emitted X-PAYMENT payload, or null when the middleware refused. */
  paymentPayload: paymentPayloadSchema.nullable(),
  /** Settlement response when paid; null when refused. */
  settlement: settlementResponseSchema.nullable(),
  events: z.array(trialEventSchema),
  metrics: x402DriftMetricsSchema,
  provenance: trialProvenanceSchema,
  usage: usageTelemetrySchema.nullable(),
  transcript: transcriptSchema.nullable(),
});

export const x402DriftResultManifestSchema = z.object({
  artifactSchemaVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  x402ProtocolVersion: z.number().int().positive(),
  extensionUri: z.literal(SEMANTIC_EXTENSION_URI),
  experimentId: z.string().min(1),
  runId: z.string().min(1),
  mode: z.enum(["deterministic-harness", "model-pilot", "confirmatory"]),
  evidenceClaim: z.string().min(1),
  createdAt: z.string().datetime(),
  orderSeed: z.number().int().nonnegative(),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  conditions: z.array(x402DriftConditionSchema).min(1),
  scenarioCount: z.number().int().positive(),
  driftScenarioCount: z.number().int().nonnegative(),
  cleanScenarioCount: z.number().int().nonnegative(),
  trialCount: z.number().int().positive(),
  fixtureDigest: z.string().length(64),
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

export const scenarioDriftSchema = z.object({
  /** The single handle whose definition the payer's registry has drifted. */
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  fieldPath: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
  mutatedDefinition: semanticDefinitionSchema,
});

export const x402DriftScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    description: z.string().min(1),
    /** Payer-facing resource description on the 402 requirements (never annotated). */
    resourceDescription: z.string().min(1),
    resource: z.string().min(1),
    scheme: z.string().min(1),
    network: z.string().min(1),
    maxAmountRequired: z.string().min(1),
    asset: z.string().min(1),
    payTo: z.string().min(1),
    maxTimeoutSeconds: z.number().int().positive(),
    /** Canonical registry contents shared by both parties before drift. */
    patterns: z.array(registeredPatternSchema).min(1),
    /** Handles the acceptance contract requires. Subset of `patterns`. */
    acceptanceHandles: z.array(z.string().regex(/^[A-Z][A-Za-z0-9]*$/)).min(1),
    /** Cross-party registry drift, or `null` for a no-drift control. */
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
    for (const handle of scenario.acceptanceHandles) {
      if (!defined.has(handle)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Acceptance handle ${handle} is not a registered pattern.`,
          path: ["acceptanceHandles"],
        });
      }
    }
    if (scenario.drift && !defined.has(scenario.drift.handle)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Drift handle ${scenario.drift.handle} is not a registered pattern.`,
        path: ["drift", "handle"],
      });
    }
    if (
      scenario.drift &&
      !scenario.acceptanceHandles.includes(scenario.drift.handle)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Drift handle ${scenario.drift.handle} must be in acceptanceHandles.`,
        path: ["drift", "handle"],
      });
    }
  });

export const x402DriftFixtureSetSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  scenarios: z.array(x402DriftScenarioSchema).min(1),
});

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type SemanticReference = z.infer<typeof semanticReferenceSchema>;
export type AcceptanceContract = z.infer<typeof acceptanceContractSchema>;
export type PaymentRequirements = z.infer<typeof paymentRequirementsSchema>;
export type PaymentRequirementsResponse = z.infer<
  typeof paymentRequirementsResponseSchema
>;
export type PaymentPayload = z.infer<typeof paymentPayloadSchema>;
export type SettlementResponse = z.infer<typeof settlementResponseSchema>;
export type PaymentState = z.infer<typeof paymentStateSchema>;
export type X402DriftCondition = z.infer<typeof x402DriftConditionSchema>;
export type X402DriftMetrics = z.infer<typeof x402DriftMetricsSchema>;
export type X402DriftTrialRecord = z.infer<typeof x402DriftTrialRecordSchema>;
export type X402DriftResultManifest = z.infer<
  typeof x402DriftResultManifestSchema
>;
export type RegisteredPattern = z.infer<typeof registeredPatternSchema>;
export type ScenarioDrift = z.infer<typeof scenarioDriftSchema>;
export type X402DriftScenario = z.infer<typeof x402DriftScenarioSchema>;
export type X402DriftFixtureSet = z.infer<typeof x402DriftFixtureSetSchema>;
