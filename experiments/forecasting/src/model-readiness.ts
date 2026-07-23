import { readFile } from "node:fs/promises";

import type { SemanticReferenceProvider } from "@sema-evals/adapters";
import { fingerprint, sha256Text } from "@sema-evals/core";
import { parse } from "yaml";

import {
  historicalForecastingDatasetSchema,
  leakageAuditDocumentSchema,
  type HistoricalForecastingDataset,
  type LeakageAuditDocument,
} from "./schemas.js";

export interface ValidatedHistoricalDataset {
  dataset: HistoricalForecastingDataset;
  digest: string;
}

const SEMA_SEMANTIC_FIELDS = new Set([
  "dependencies",
  "signature",
  "data_schema",
  "mechanism",
  "gloss",
  "invariants",
  "preconditions",
  "postconditions",
  "parameters",
  "failure_modes",
  "derived_from",
]);

function assertDefinitionUsesSemaFields(
  scenarioId: string,
  definition: Record<string, unknown>,
): void {
  for (const field of Object.keys(definition)) {
    if (!SEMA_SEMANTIC_FIELDS.has(field)) {
      throw new Error(
        `${scenarioId}: definition uses top-level field ${field}, which is outside Sema's semantic hash surface.`,
      );
    }
  }
}

/**
 * Validates that an input is a genuinely historical replay dataset.  This is
 * intentionally stricter than the deterministic-fixture loader: every market
 * must have an outcome provenance record. The first pilot is the registered
 * no-evidence arm, so evidence packs must be absent; when the later
 * evidence-pack arm is registered, non-null packs are checked for retained,
 * licensed, digest-checked bytes dated no later than their cutoff.
 */
export async function loadHistoricalForecastingDataset(
  path: string,
): Promise<ValidatedHistoricalDataset> {
  const raw = await readFile(path, "utf8");
  const dataset = historicalForecastingDatasetSchema.parse(parse(raw));
  const ids = new Set<string>();
  for (const scenario of dataset.scenarios) {
    if (!ids.add(scenario.id))
      throw new Error(`Duplicate scenario id: ${scenario.id}.`);
    const { question } = scenario;
    if (!question.historicalProvenance) {
      throw new Error(
        `${scenario.id}: model-pilot questions require historical provenance.`,
      );
    }
    const provenance = question.historicalProvenance;
    const marketPriorObservedAt = Date.parse(provenance.marketPriorObservedAt);
    const forecastCutoff = Date.parse(provenance.forecastCutoff);
    const resolutionTimestamp = Date.parse(question.resolutionTimestamp);
    if (
      marketPriorObservedAt > forecastCutoff ||
      forecastCutoff >= resolutionTimestamp
    ) {
      throw new Error(
        `${scenario.id}: require marketPriorObservedAt <= forecastCutoff < resolutionTimestamp.`,
      );
    }
    if (!provenance.publicationRedistributionAuthorized) {
      throw new Error(
        `${scenario.id}: source terms do not authorize publication/redistribution.`,
      );
    }
    if (question.evidencePack !== null) {
      throw new Error(
        `${scenario.id}: registered first model pilot is no-evidence; evidencePack must be null.`,
      );
    }
    for (const pattern of scenario.patterns) {
      assertDefinitionUsesSemaFields(scenario.id, pattern.definition);
    }
    if (scenario.drift) {
      assertDefinitionUsesSemaFields(
        scenario.id,
        scenario.drift.mutatedDefinition,
      );
    }
  }
  return { dataset, digest: sha256Text(raw) };
}

/** Fail before model calls if official canonicalization collapses a declared drift. */
export async function assertSemanticDriftsAddressable(
  scenarios: readonly HistoricalForecastingDataset["scenarios"][number][],
  provider: SemanticReferenceProvider,
): Promise<void> {
  for (const scenario of scenarios) {
    if (!scenario.drift) continue;
    const canonical = scenario.patterns.find(
      (pattern) => pattern.handle === scenario.drift?.handle,
    );
    if (!canonical) {
      throw new Error(
        `${scenario.id}: drift handle ${scenario.drift.handle} has no canonical definition.`,
      );
    }
    const [expected, observed] = await Promise.all([
      provider.reference(canonical.handle, canonical.definition),
      provider.reference(canonical.handle, scenario.drift.mutatedDefinition),
    ]);
    if (expected.full === observed.full) {
      throw new Error(
        `${scenario.id}: declared semantic drift collapses to one ${provider.backend} address.`,
      );
    }
  }
}

/** The audit is bound to the exact served model, dataset, and zero-evidence prompt. */
export function evaluateModelLeakageAudit(
  input: unknown,
  expected: { modelDescriptor: string; datasetDigest: string },
  scenarioIds: readonly string[],
): { passed: boolean; failures: string[]; document: LeakageAuditDocument } {
  const document = leakageAuditDocumentSchema.parse(input);
  const failures: string[] = [];
  if (document.schemaVersion !== "forecasting-model-leakage-audit-v1") {
    failures.push("model leakage audit has the wrong schema version");
  }
  if (document.modelDescriptor !== expected.modelDescriptor) {
    failures.push("model leakage audit is not for the selected provider/model");
  }
  if (document.datasetDigest !== expected.datasetDigest) {
    failures.push("model leakage audit is not for this frozen dataset");
  }
  if (!document.zeroEvidencePrompt) {
    failures.push(
      "model leakage audit is missing its frozen zero-evidence prompt",
    );
  }
  if (document.protocolFingerprint !== LEAKAGE_AUDIT_PROTOCOL_FINGERPRINT) {
    failures.push("model leakage audit has the wrong protocol fingerprint");
  }
  if (!document.aggregate?.passed) {
    failures.push("model leakage audit aggregate gate did not pass");
  }
  const byId = new Map(
    document.entries.map((entry) => [entry.scenarioId, entry.audit]),
  );
  for (const scenarioId of scenarioIds) {
    const audit = byId.get(scenarioId);
    if (!audit) {
      failures.push(`${scenarioId}: missing model leakage audit`);
      continue;
    }
    if (
      audit.verdict !== "keep" ||
      audit.modelDescriptor !== expected.modelDescriptor ||
      !audit.promptFingerprint ||
      !audit.auditedAt ||
      audit.evidenceExcluded !== true ||
      !audit.rawOutput ||
      !audit.modelRevision ||
      !audit.trainingCutoff ||
      !audit.reviewer ||
      !audit.rationale ||
      !audit.auditStatus ||
      !audit.transcript ||
      !audit.usage
    ) {
      failures.push(
        `${scenarioId}: incomplete or rejected model leakage audit`,
      );
    }
  }
  return { passed: failures.length === 0, failures, document };
}

export const LEAKAGE_AUDIT_PROTOCOL_FINGERPRINT = fingerprint({
  version: "forecasting-model-leakage-audit-v2-temporal-binomial",
  prompt:
    "question-and-resolution-criteria-only; no evidence pack; strict JSON answer, confidence, and basis",
  verdict:
    "keep only when at least 90% of unique questions parse and a one-sided exact binomial test does not beat chance at alpha 0.01",
  temporalGuard:
    "selected model released in 2024; every included market resolved in 2026",
  scoring:
    "blind outcomes during inference; compute accuracy only after all zero-evidence calls settle; model self-reports are not a scorer",
});
