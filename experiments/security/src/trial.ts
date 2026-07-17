import type { SemanticReferenceProvider } from "@sema-evals/adapters";
import {
  fingerprint,
  utf8Bytes,
  type MatrixCell,
  type TrialEvent,
  type TrialProvenance,
} from "@sema-evals/core";

import { conditionPolicy } from "./conditions.js";
import { applyEnforcementGate } from "./gate.js";
import { cannedKey, cannedOutputFor, cardDefinition } from "./fixtures.js";
import {
  parseAuditorOutput,
  scoreFindings,
  SECURITY_SCORER_VERSION,
} from "./scorer.js";
import type {
  PatternCard,
  SecurityCondition,
  SecurityMetrics,
  SecurityTrialRecord,
  SecurityTrialScenario,
} from "./schemas.js";
import { securityTrialRecordSchema } from "./schemas.js";

export interface SecurityTrialOptions {
  experimentId: string;
  referenceProvider: SemanticReferenceProvider;
  cards: readonly PatternCard[];
  cannedEntries: Readonly<Record<string, string>>;
  provenance: TrialProvenance;
  fpBudget: number;
}

/**
 * Substitutes `__DIGEST_<Handle>__` placeholders in canned auditor text with
 * digests from the shared reference provider, so the fixture file stays
 * digest-agnostic across fixture vs sema-python backends.
 */
export async function materializeCannedOutput(
  template: string,
  cards: readonly PatternCard[],
  referenceProvider: SemanticReferenceProvider,
): Promise<{ text: string; digestsByHandle: Map<string, string> }> {
  const digestsByHandle = new Map<string, string>();
  let text = template;
  for (const card of cards) {
    const reference = await referenceProvider.reference(
      card.handle,
      cardDefinition(card),
    );
    digestsByHandle.set(card.handle, reference.digest);
    text = text.replaceAll(`__DIGEST_${card.handle}__`, reference.digest);
  }
  return { text, digestsByHandle };
}

function renderInlineCards(cards: readonly PatternCard[]): string {
  return cards
    .map((card) => {
      const body = [
        `# ${card.handle}: ${card.title}`,
        card.description,
        ...card.checklist.map((item) => `- ${item}`),
      ].join("\n");
      return body;
    })
    .join("\n\n");
}

/**
 * Runs one instrumentation trial: loads the canned auditor output for the
 * (case, condition) cell, applies the addressed-enforced gate when required,
 * and scores against case.json labels. No model is called.
 */
export async function runSecurityTrial(
  cell: MatrixCell<SecurityTrialScenario, SecurityCondition>,
  options: SecurityTrialOptions,
): Promise<SecurityTrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const scenario = cell.scenario;
  const condition = cell.condition;
  const policy = conditionPolicy(condition);
  const events: TrialEvent[] = [];
  let sequence = 0;

  const deliveredCards = policy.deliversCards ? options.cards : [];

  let wireBytes = 0;
  let hydrationBytes = 0;
  const digestsByClass = new Map<string, string>();

  // The model-facing task contains source only. Case id, variant, class, split,
  // mutation metadata, and labels are scorer-side ground truth.
  const taskPayload = { source: scenario.source };
  wireBytes += utf8Bytes(taskPayload);

  if (policy.onWire === "inline-definitions") {
    const prose = renderInlineCards(deliveredCards);
    wireBytes += utf8Bytes(prose);
    events.push({
      sequence: sequence++,
      type: "message",
      boundary: null,
      agent: "security-harness",
      details: { transport: "inline-definitions", wireBytes },
    });
  } else if (policy.onWire === "content-references") {
    for (const card of deliveredCards) {
      const reference = await options.referenceProvider.reference(
        card.handle,
        cardDefinition(card),
      );
      wireBytes += utf8Bytes({ ref: reference.full });
      if (policy.hydratesFromRegistry) {
        const definitionBytes = utf8Bytes(cardDefinition(card));
        hydrationBytes += definitionBytes;
      }
      digestsByClass.set(card.class, reference.digest);
    }
    events.push({
      sequence: sequence++,
      type: "message",
      boundary: null,
      agent: "security-harness",
      details: {
        transport: "content-references",
        wireBytes,
        hydrationBytes,
      },
    });
  } else {
    events.push({
      sequence: sequence++,
      type: "message",
      boundary: null,
      agent: "security-harness",
      details: { transport: "task-only", wireBytes },
    });
  }

  const key = cannedKey(scenario.meta.id, condition, scenario.sourceVariant);
  const template = cannedOutputFor(
    options.cannedEntries,
    scenario.meta.id,
    condition,
    scenario.sourceVariant,
  );
  if (template === undefined) {
    throw new Error(
      `Missing canned findings for ${scenario.meta.id} (${scenario.sourceVariant})::${condition}.`,
    );
  }

  const { text: auditorOutput } = await materializeCannedOutput(
    template,
    options.cards,
    options.referenceProvider,
  );

  events.push({
    sequence: sequence++,
    type: "completion",
    boundary: null,
    agent: "scripted-auditor",
    details: {
      cannedKey: key,
      outputBytes: utf8Bytes(auditorOutput),
      scorerVersion: SECURITY_SCORER_VERSION,
    },
  });

  const parsed = parseAuditorOutput(auditorOutput);
  let enforcementRefused = false;
  let admitted = parsed;

  if (policy.enforcesDecisionRefs) {
    // Require references for the classes the auditor actually claimed. This
    // avoids using case ground truth to decide which references are required.
    const requiredDigests = [
      ...new Set(
        parsed.findings.map((finding) => {
          const digest = digestsByClass.get(finding.class);
          if (!digest) {
            throw new Error(`No Pattern Card for class ${finding.class}.`);
          }
          return digest;
        }),
      ),
    ];
    const gate = applyEnforcementGate(parsed, requiredDigests);
    enforcementRefused = gate.refused;
    admitted = gate.admitted;
    events.push({
      sequence: sequence++,
      type: "verification",
      boundary: null,
      agent: "enforcement-gate",
      details: {
        refused: gate.refused,
        reason: gate.reason,
        requiredDigests,
      },
    });
  }

  const score = scoreFindings(
    scenario.expectedFindings,
    admitted,
    options.fpBudget,
  );

  const metrics: SecurityMetrics = {
    split: scenario.meta.split,
    sourceVariant: scenario.sourceVariant,
    vulnerabilityClass: scenario.meta.class,
    parseFailure: score.parseFailure || !parsed.parseable,
    enforcementRefused,
    expectedCount: score.expectedCount,
    truePositives: score.truePositives,
    falsePositives: score.falsePositives,
    falseNegatives: score.falseNegatives,
    recall: score.recall,
    withinFpBudget: score.withinFpBudget,
    fpBudget: options.fpBudget,
    wireBytes,
    hydrationBytes,
    totalSemanticBytes: wireBytes + hydrationBytes,
    elapsedMs: performance.now() - started,
  };

  const record: SecurityTrialRecord = {
    trialId: cell.trialId,
    experimentId: options.experimentId,
    scenarioId: cell.scenarioId,
    caseId: scenario.meta.id,
    sourceVariant: scenario.sourceVariant,
    condition,
    seed: cell.seed,
    executionIndex: cell.executionIndex,
    startedAt,
    completedAt: new Date().toISOString(),
    events,
    metrics,
    provenance: options.provenance,
    usage: null,
    transcript: null,
    auditorOutput,
  };

  return securityTrialRecordSchema.parse(record);
}

/** Digest fingerprint helper exported for tests. */
export function fingerprintCard(card: PatternCard): string {
  return fingerprint(cardDefinition(card));
}
