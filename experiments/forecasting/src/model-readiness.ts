import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import type { SemanticReferenceProvider } from "@sema-evals/adapters";
import { fingerprint, sha256Text } from "@sema-evals/core";
import { parse } from "yaml";

import {
  historicalForecastingDatasetSchema,
  leakageAuditDocumentSchema,
  type HistoricalForecastingDataset,
  type EvidenceItem,
  type LeakageAuditDocument,
} from "./schemas.js";

export interface LoadedEvidenceItem {
  item: EvidenceItem;
  /** Exact, digest-verified local bytes decoded as UTF-8 for the model. */
  frozenText: string;
}

export interface ValidatedHistoricalDataset {
  dataset: HistoricalForecastingDataset;
  digest: string;
  /** Evidence is intentionally kept outside the YAML payload after validation. */
  evidenceByScenario: ReadonlyMap<string, readonly LoadedEvidenceItem[]>;
  evidencePackFingerprint: string | null;
  questionSetFingerprint: string;
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

/** Ordered unique identities make audit rebinds explicit and checkable. */
export function forecastingQuestionSetFingerprint(
  scenarios: readonly HistoricalForecastingDataset["scenarios"][number][],
): string {
  const seen = new Set<string>();
  const identities: { questionText: string; resolutionCriteria: string }[] = [];
  for (const scenario of scenarios) {
    const identity = {
      questionText: scenario.question.questionText,
      resolutionCriteria: scenario.question.resolutionCriteria,
    };
    const key = fingerprint(identity);
    if (!seen.has(key)) {
      seen.add(key);
      identities.push(identity);
    }
  }
  return fingerprint(identities);
}

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
  const evidenceByScenario = new Map<string, readonly LoadedEvidenceItem[]>();
  const datasetDirectory = dirname(resolve(path));
  const evidencePacks: unknown[] = [];
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
    if (dataset.informationArm === "no-evidence-v1") {
      if (question.evidencePack !== null) {
        throw new Error(
          `${scenario.id}: registered no-evidence arm requires evidencePack to be null.`,
        );
      }
    } else {
      const pack = question.evidencePack;
      if (!pack) {
        throw new Error(
          `${scenario.id}: frozen-market-signal arm requires an evidence pack.`,
        );
      }
      if (pack.cutoff !== provenance.forecastCutoff) {
        throw new Error(
          `${scenario.id}: evidence pack cutoff must exactly equal forecastCutoff.`,
        );
      }
      if (pack.items.length !== 1) {
        throw new Error(
          `${scenario.id}: frozen-market-signal arm requires exactly one source-market signal.`,
        );
      }
      const loadedItems: LoadedEvidenceItem[] = [];
      for (const item of pack.items) {
        if (
          !/source-market YES/i.test(item.summary) ||
          /\boutcome\b|\bresolved\b/i.test(item.summary)
        ) {
          throw new Error(
            `${scenario.id}: evidence ${item.id} summary must identify source-market YES and must not contain an outcome.`,
          );
        }
        if (
          !item.observedAt ||
          item.observedAt !== provenance.marketPriorObservedAt ||
          Date.parse(item.observedAt) > forecastCutoff
        ) {
          throw new Error(
            `${scenario.id}: evidence ${item.id} observedAt must match the frozen market-prior observation and be no later than forecastCutoff.`,
          );
        }
        if (Date.parse(item.publishedAt) > forecastCutoff) {
          throw new Error(
            `${scenario.id}: evidence ${item.id} was published after forecastCutoff.`,
          );
        }
        if (
          item.sourceName !== provenance.marketSourceName ||
          item.sourceUrl !== provenance.marketSourceUrl ||
          item.license !== provenance.marketLicense
        ) {
          throw new Error(
            `${scenario.id}: evidence ${item.id} source and licence must match historical market provenance.`,
          );
        }
        const frozenPath = resolve(datasetDirectory, item.frozenPath);
        const pathFromDataset = relative(datasetDirectory, frozenPath);
        if (pathFromDataset.startsWith("..") || pathFromDataset === "") {
          throw new Error(
            `${scenario.id}: evidence ${item.id} frozenPath must stay below the dataset directory.`,
          );
        }
        const frozenBytes = await readFile(frozenPath);
        const digest = createHash("sha256").update(frozenBytes).digest("hex");
        if (digest !== item.sha256) {
          throw new Error(
            `${scenario.id}: evidence ${item.id} bytes digest does not match declared sha256.`,
          );
        }
        const frozenText = frozenBytes.toString("utf8");
        if (Buffer.from(frozenText, "utf8").compare(frozenBytes) !== 0) {
          throw new Error(
            `${scenario.id}: evidence ${item.id} frozen bytes must be valid UTF-8.`,
          );
        }
        // The frozen signal is model-facing. Do not let a resolved label enter it.
        if (
          /\bresolved[_ -]?outcome\b|\bsettlement\s*[:=]|\bsource[_ -]?outcome\b/i.test(
            frozenText,
          )
        ) {
          throw new Error(
            `${scenario.id}: evidence ${item.id} appears to contain a resolved outcome field.`,
          );
        }
        const signal = frozenText.match(
          /^source_market_yes_probability: (0\.\d{4}|1\.0000)\nobserved_at: ([^\n]+)\n$/,
        );
        if (!signal) {
          throw new Error(
            `${scenario.id}: evidence ${item.id} must contain exactly one four-decimal source-market YES probability and observed_at.`,
          );
        }
        const probability = Number(signal[1]);
        if (
          Math.abs(probability - question.marketPrior) > Number.EPSILON ||
          signal[2] !== item.observedAt
        ) {
          throw new Error(
            `${scenario.id}: evidence ${item.id} signal must match the frozen market prior and declared observation time.`,
          );
        }
        loadedItems.push({ item, frozenText });
      }
      evidenceByScenario.set(scenario.id, loadedItems);
      evidencePacks.push({ scenarioId: scenario.id, pack });
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
  if (dataset.informationArm === "frozen-market-signal-v1") {
    const bytesByQuestion = new Map<string, string>();
    for (const scenario of dataset.scenarios) {
      const bytes = (evidenceByScenario.get(scenario.id) ?? [])
        .map((entry) => entry.frozenText)
        .join("\u0000");
      const existing = bytesByQuestion.get(scenario.question.questionText);
      if (existing !== undefined && existing !== bytes) {
        throw new Error(
          `${scenario.id}: paired scenarios for one question must serve identical frozen evidence bytes.`,
        );
      }
      bytesByQuestion.set(scenario.question.questionText, bytes);
    }
  }
  return {
    dataset,
    digest: sha256Text(raw),
    evidenceByScenario,
    evidencePackFingerprint:
      dataset.informationArm === "frozen-market-signal-v1"
        ? fingerprint(evidencePacks)
        : null,
    questionSetFingerprint: forecastingQuestionSetFingerprint(
      dataset.scenarios,
    ),
  };
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
  expected: {
    modelDescriptor: string;
    datasetDigest: string;
    informationArm?: HistoricalForecastingDataset["informationArm"];
    evidencePackFingerprint?: string | null;
    questionSetFingerprint?: string;
  },
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
  if (expected.informationArm === "frozen-market-signal-v1") {
    if (document.informationArm !== expected.informationArm) {
      failures.push(
        "model leakage audit is not registered for the evidence arm",
      );
    }
    if (document.evidencePackFingerprint !== expected.evidencePackFingerprint) {
      failures.push(
        "model leakage audit is not bound to these frozen evidence bytes",
      );
    }
    if (document.questionSetFingerprint !== expected.questionSetFingerprint) {
      failures.push(
        "model leakage audit is not bound to this question/resolution identity set",
      );
    }
    if (!document.evidencePrompt) {
      failures.push(
        "model leakage audit is missing its frozen-evidence prompt",
      );
    }
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
