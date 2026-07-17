import {
  trialEventSchema,
  trialProvenanceSchema,
  transcriptSchema,
  usageTelemetrySchema,
} from "@sema-evals/core";
import { z } from "zod";

/**
 * A2A semantic-extension experiment (RESEARCH_PLAN Phase 3).
 *
 * The A2A (Agent2Agent) wire shapes below are modelled faithfully in-repo as
 * typed zod schemas rather than taken from an external SDK: determinism and
 * dependency-lightness win, and real-SDK conformance is future work (see ADR
 * 0012). The Sema semantic extension rides ENTIRELY inside A2A's own extension
 * points — `AgentCard.capabilities.extensions` for advertisement and a tagged
 * `DataPart` for the acceptance contract on a task message — so no core A2A
 * message field is ever repurposed. "Extension-compatible, no fork" is literal.
 */

/** The canonicalization/vocabulary-root extension this experiment advertises.
 * A2A extensions are identified by URI; this is ours. */
export const SEMANTIC_EXTENSION_URI =
  "https://sema-evals.dev/a2a/ext/semantic-canonicalization/v0.1";

/** A2A protocol version modelled by these shapes. */
export const A2A_PROTOCOL_VERSION = "0.3.0";

/* -------------------------------------------------------------------------- */
/* A2A Agent Card                                                             */
/* -------------------------------------------------------------------------- */

/**
 * An A2A `AgentExtension` descriptor as it appears under
 * `AgentCard.capabilities.extensions`. `uri` names the extension, `required`
 * marks whether a client must understand it, and `params` carries
 * extension-specific configuration. Our semantic extension's params advertise
 * the canonicalization version and vocabulary root exactly as Phase 3 requires.
 */
export const semanticExtensionParamsSchema = z.object({
  canonicalizationVersion: z.string().min(1),
  vocabularyRoot: z.string(),
  backend: z.string().min(1),
  /** Whether this agent's middleware enforces the acceptance contract
   * (fail-closed) or merely permits voluntary verification. */
  enforcement: z.enum(["voluntary", "enforced"]),
});

export const agentExtensionSchema = z.object({
  uri: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean(),
  params: z.record(z.string(), z.unknown()),
});

export const agentCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  pushNotifications: z.boolean(),
  extensions: z.array(agentExtensionSchema),
});

export const agentSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
});

export const agentCardSchema = z.object({
  protocolVersion: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  url: z.string().min(1),
  version: z.string().min(1),
  capabilities: agentCapabilitiesSchema,
  defaultInputModes: z.array(z.string().min(1)),
  defaultOutputModes: z.array(z.string().min(1)),
  skills: z.array(agentSkillSchema),
});

/* -------------------------------------------------------------------------- */
/* A2A messages and typed parts                                               */
/* -------------------------------------------------------------------------- */

/** An A2A `TextPart`: the natural-language task content. Never repurposed to
 * carry semantic references. */
export const textPartSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** An A2A `DataPart`: structured JSON content. The semantic extension attaches
 * its acceptance contract here, tagged in `metadata` with the extension URI, so
 * a non-participating agent can ignore it and core fields stay untouched. */
export const dataPartSchema = z.object({
  kind: z.literal("data"),
  data: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const partSchema = z.discriminatedUnion("kind", [
  textPartSchema,
  dataPartSchema,
]);

export const a2aMessageSchema = z.object({
  role: z.enum(["user", "agent"]),
  parts: z.array(partSchema).min(1),
  messageId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  contextId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/* -------------------------------------------------------------------------- */
/* Semantic extension payload (rides in a DataPart)                           */
/* -------------------------------------------------------------------------- */

/** A content-addressed semantic reference for one pattern handle: the full
 * reference string, its digest, and the canonicalization version that produced
 * it. This is the addressing channel — a changed definition changes `ref`. */
export const semanticReferenceSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  ref: z.string().min(1),
  digest: z.string().length(64),
  canonicalizationVersion: z.string().min(1),
});

/**
 * The acceptance contract the requester attaches to a task message. It names
 * the handles the worker must honor, binds each to a required content-addressed
 * reference, and declares whether the binding is enforced (fail-closed) or
 * voluntary. A worker's middleware may transition the task to `completed` only
 * when every required reference resolves-matches under `enforced`.
 */
export const acceptanceContractSchema = z.object({
  contractId: z.string().min(1),
  extensionUri: z.literal(SEMANTIC_EXTENSION_URI),
  enforcement: z.enum(["voluntary", "enforced"]),
  requiredReferences: z.array(semanticReferenceSchema).min(1),
});

/* -------------------------------------------------------------------------- */
/* A2A task lifecycle                                                         */
/* -------------------------------------------------------------------------- */

/** The A2A `TaskState` enum. The demo only reaches `completed` and `failed`,
 * but the full set is modelled for faithfulness. */
export const taskStateSchema = z.enum([
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "auth-required",
  "unknown",
]);

/* -------------------------------------------------------------------------- */
/* Experiment record shapes                                                   */
/* -------------------------------------------------------------------------- */

export const A2A_DRIFT_CONDITIONS = [
  "baseline",
  "advertised-voluntary",
  "advertised-enforced",
] as const;

export const a2aDriftConditionSchema = z.enum(A2A_DRIFT_CONDITIONS);

/**
 * Per-trial measurements. The primary endpoint is `silentExecution`: the worker
 * completed the task using its own drifted definition with no surfaced
 * mismatch. `driftDetected` and `halted` are decomposed so voluntary detection
 * (detected, not halted) is distinguishable from enforced halt (detected AND
 * task failed), and `falseHalt` guards the no-drift controls.
 */
export const a2aDriftMetricsSchema = z.object({
  driftInjected: z.boolean(),
  extensionAdvertised: z.boolean(),
  referencesCarried: z.boolean(),
  verificationPerformed: z.boolean(),
  referencesChecked: z.number().int().nonnegative(),
  referencesMatched: z.number().int().nonnegative(),
  referencesMismatched: z.number().int().nonnegative(),
  driftDetected: z.boolean(),
  halted: z.boolean(),
  /** Primary endpoint: drift injected but never surfaced — the worker shipped
   * drifted work silently. */
  silentExecution: z.boolean(),
  correctHalt: z.boolean(),
  falseHalt: z.boolean(),
  /** Reached the safety-correct terminal state for its (scenario, condition). */
  taskSuccess: z.boolean(),
  finalTaskState: taskStateSchema,
  failureReason: z.string().nullable(),
  wireBytes: z.number().int().nonnegative(),
  hydrationBytes: z.number().int().nonnegative(),
  totalSemanticBytes: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});

export const workerDecisionSchema = z.enum(["proceed", "halt", "malformed"]);
export const modelCompletionStatusSchema = z.enum([
  "completed",
  "refused",
  "truncated",
  "error",
]);

export const a2aDriftTrialRecordSchema = z.object({
  trialId: z.string().length(64),
  experimentId: z.string().min(1),
  scenarioId: z.string().min(1),
  condition: a2aDriftConditionSchema,
  seed: z.number().int().nonnegative(),
  executionIndex: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  driftInjected: z.boolean(),
  finalTaskState: taskStateSchema,
  /** Both cards captured for evidence: the extension advertisement (or its
   * absence in baseline) is part of the record. */
  requesterCard: agentCardSchema,
  workerCard: agentCardSchema,
  events: z.array(trialEventSchema),
  metrics: a2aDriftMetricsSchema,
  provenance: trialProvenanceSchema,
  usage: usageTelemetrySchema.nullable(),
  transcript: transcriptSchema.nullable(),
  /** Provider-level completion status; null in the deterministic harness. */
  modelCompletionStatus: modelCompletionStatusSchema.nullable(),
  /** Parsed worker DECISION line; null in the deterministic harness. */
  modelDecision: workerDecisionSchema.nullable(),
  /** Frozen parser version that produced `modelDecision`; null when unused. */
  decisionParserVersion: z.string().nullable(),
});

export const a2aDriftResultManifestSchema = z.object({
  artifactSchemaVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  a2aProtocolVersion: z.string().min(1),
  extensionUri: z.literal(SEMANTIC_EXTENSION_URI),
  experimentId: z.string().min(1),
  runId: z.string().min(1),
  mode: z.enum(["deterministic-harness", "model-pilot", "confirmatory"]),
  evidenceClaim: z.string().min(1),
  createdAt: z.string().datetime(),
  orderSeed: z.number().int().nonnegative(),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  conditions: z.array(a2aDriftConditionSchema).min(1),
  scenarioCount: z.number().int().positive(),
  driftScenarioCount: z.number().int().nonnegative(),
  cleanScenarioCount: z.number().int().nonnegative(),
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

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

export const semanticDefinitionSchema = z.record(z.string(), z.unknown());

export const registeredPatternSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  definition: semanticDefinitionSchema,
});

export const scenarioDriftSchema = z.object({
  /** The single handle whose definition the worker's registry has drifted. */
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  fieldPath: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
  mutatedDefinition: semanticDefinitionSchema,
});

export const a2aDriftScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    description: z.string().min(1),
    /** The natural-language task (the A2A TextPart). */
    task: z.string().min(1),
    /** Canonical registry contents shared by both agents before drift. */
    patterns: z.array(registeredPatternSchema).min(1),
    /** Handles the acceptance contract requires. Subset of `patterns`. */
    acceptanceHandles: z.array(z.string().regex(/^[A-Z][A-Za-z0-9]*$/)).min(1),
    /** Cross-agent registry drift, or `null` for a no-drift control. */
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
    // A drift the acceptance contract never checks could not be caught: the
    // fixture would silently misrepresent the experiment. Require the drifted
    // handle to be under contract.
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

export const a2aDriftFixtureSetSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  scenarios: z.array(a2aDriftScenarioSchema).min(1),
});

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type SemanticExtensionParams = z.infer<
  typeof semanticExtensionParamsSchema
>;
export type AgentExtension = z.infer<typeof agentExtensionSchema>;
export type AgentCard = z.infer<typeof agentCardSchema>;
export type TextPart = z.infer<typeof textPartSchema>;
export type DataPart = z.infer<typeof dataPartSchema>;
export type Part = z.infer<typeof partSchema>;
export type A2aMessage = z.infer<typeof a2aMessageSchema>;
export type SemanticReference = z.infer<typeof semanticReferenceSchema>;
export type AcceptanceContract = z.infer<typeof acceptanceContractSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type A2aDriftCondition = z.infer<typeof a2aDriftConditionSchema>;
export type A2aDriftMetrics = z.infer<typeof a2aDriftMetricsSchema>;
export type A2aDriftTrialRecord = z.infer<typeof a2aDriftTrialRecordSchema>;
export type A2aDriftResultManifest = z.infer<
  typeof a2aDriftResultManifestSchema
>;
export type RegisteredPattern = z.infer<typeof registeredPatternSchema>;
export type ScenarioDrift = z.infer<typeof scenarioDriftSchema>;
export type A2aDriftScenario = z.infer<typeof a2aDriftScenarioSchema>;
export type A2aDriftFixtureSet = z.infer<typeof a2aDriftFixtureSetSchema>;
