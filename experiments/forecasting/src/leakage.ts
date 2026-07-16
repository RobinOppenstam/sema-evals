import type {
  ForecastingScenario,
  LeakageAuditDocument,
  LeakageAuditEntry,
} from "./schemas.js";
import { leakageAuditDocumentSchema } from "./schemas.js";

/**
 * Builds the leakage-audit document for a result bundle from the scenarios
 * that were included in the run. Every scenario contributes its fixture audit
 * entry keyed by scenario id.
 */
export function buildLeakageAuditDocument(
  scenarios: readonly ForecastingScenario[],
): LeakageAuditDocument {
  return leakageAuditDocumentSchema.parse({
    schemaVersion: "0.1.0",
    entries: scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      audit: scenario.leakageAudit,
    })),
  });
}

/**
 * The Phase 5 leakage-audit gate: every included question must carry an audit
 * entry with verdict `keep`. Returns `{ passed, failures }` so the summary and
 * CLI can fail the run when any question is missing or dropped.
 */
export function evaluateLeakageAuditGate(
  scenarios: readonly ForecastingScenario[],
  auditsByScenarioId: ReadonlyMap<string, LeakageAuditEntry>,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const scenario of scenarios) {
    const audit = auditsByScenarioId.get(scenario.id);
    if (!audit) {
      failures.push(`${scenario.id}: missing leakage audit entry`);
      continue;
    }
    if (audit.verdict !== "keep") {
      failures.push(
        `${scenario.id}: leakage audit verdict is ${audit.verdict}, expected keep`,
      );
    }
  }
  return { passed: failures.length === 0, failures };
}

/**
 * Convenience: evaluate the gate directly from a fixture-backed scenario list
 * (each scenario already embeds its audit entry).
 */
export function evaluateLeakageAuditGateFromScenarios(
  scenarios: readonly ForecastingScenario[],
): { passed: boolean; failures: string[] } {
  const audits = new Map(
    scenarios.map((scenario) => [scenario.id, scenario.leakageAudit]),
  );
  return evaluateLeakageAuditGate(scenarios, audits);
}
