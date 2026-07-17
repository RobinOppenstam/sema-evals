import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import {
  ARTIFACT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  executeMatrix,
  planPairedMatrix,
  fingerprint,
  utf8Bytes,
  type TrialProvenance,
} from "@sema-evals/core";
import { writeResultBundleWith } from "@sema-evals/reporters";
import { afterAll, describe, expect, it } from "vitest";

import { buildConditions } from "../src/conditions.js";
import {
  buildSecurityTrialScenarios,
  loadCannedFindings,
  loadCases,
} from "../src/fixtures.js";
import { assertNoCardLeakage, loadPatternCards } from "../src/leakage.js";
import {
  securityResultManifestSchema,
  securityTrialRecordSchema,
} from "../src/schemas.js";
import {
  SECURITY_SCORER_FINGERPRINT,
  SECURITY_SCORER_VERSION,
} from "../src/scorer.js";
import { securitySummaryMarkdown, summarizeSecurity } from "../src/summary.js";
import { runSecurityTrial } from "../src/trial.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_DIR = join(ROOT, "fixtures/cases");
const CARDS_DIR = join(ROOT, "vocabulary/sema-sec");
const CANNED_PATH = join(ROOT, "fixtures/canned-findings.json");
const FP_BUDGET = 1;

const provenance: TrialProvenance = {
  artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  fixtureDigest: "a".repeat(64),
  implementationCommit: "test",
  dependencyLockDigest: "b".repeat(64),
  promptDigest: "c".repeat(64),
  semaVersion: "not-connected",
  canonicalizationVersion: "fixture-stable-json-v1",
  vocabularyRoot: "",
  semanticBackend: "fixture-sha256-stable-json-v1",
  modelProvider: "deterministic",
  modelName: "security-scripted-auditor-v1",
};

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function runMatrix(seeds: number[]) {
  const loaded = await loadCases(CASES_DIR);
  const cardSet = await loadPatternCards(CARDS_DIR);
  assertNoCardLeakage(
    cardSet.cards,
    loaded.cases.map((entry) => entry.meta),
  );
  const canned = await loadCannedFindings(CANNED_PATH);
  const conditions = buildConditions();
  const scenarios = buildSecurityTrialScenarios(loaded.cases);
  const cells = planPairedMatrix({
    experimentId: "security",
    protocolVersion: PROTOCOL_VERSION,
    scenarios,
    scenarioId: (scenario) => scenario.scenarioId,
    conditions,
    seeds,
    orderSeed: 20_260_716,
  });
  const provider = new FixtureReferenceProvider();
  const records = await executeMatrix(cells, (cell) =>
    runSecurityTrial(cell, {
      experimentId: "security",
      referenceProvider: provider,
      cards: cardSet.cards,
      cannedEntries: canned.entries,
      provenance,
      fpBudget: FP_BUDGET,
    }),
  );
  return { loaded, scenarios, conditions, cells, records, cardSet };
}

describe("instrumentation matrix", () => {
  it("produces schema-valid records for every (case, condition, seed)", async () => {
    const { loaded, conditions, records } = await runMatrix([0]);
    expect(records).toHaveLength(loaded.cases.length * 2 * conditions.length);
    for (const record of records) {
      expect(securityTrialRecordSchema.safeParse(record).success).toBe(true);
      expect(record.auditorOutput.length).toBeGreaterThan(0);
    }
    expect(
      records.filter((record) => record.sourceVariant === "patched"),
    ).toHaveLength(loaded.cases.length * conditions.length);
  });

  it("pairs every condition on the same scenario/seed blocks", async () => {
    const { cells } = await runMatrix([0, 1]);
    const conditions = buildConditions();
    const byBlock = new Map<string, Set<string>>();
    for (const cell of cells) {
      const key = `${cell.scenarioId}:${cell.seed}`;
      const set = byBlock.get(key) ?? new Set<string>();
      set.add(cell.condition);
      byBlock.set(key, set);
    }
    for (const [, set] of byBlock) {
      expect(set.size).toBe(conditions.length);
      for (const condition of conditions) {
        expect(set.has(condition)).toBe(true);
      }
    }
  });

  it("shows baseline miss vs card-arm recall on the scripted ladder", async () => {
    const { records } = await runMatrix([0]);
    const summary = summarizeSecurity(records, FP_BUDGET);
    const byCondition = new Map(
      summary.conditions.map((condition) => [condition.condition, condition]),
    );

    expect(byCondition.get("baseline")?.recallAtFpBudget).toBe(0);
    expect(byCondition.get("equal-prose")?.recallAtFpBudget).toBe(1);
    expect(byCondition.get("addressed-voluntary")?.recallAtFpBudget).toBe(1);
    expect(byCondition.get("addressed-enforced")?.recallAtFpBudget).toBe(1);
    expect(byCondition.get("addressed-enforced")?.enforcementRefusals).toBe(0);
  });

  it("does not include class, case id, or source variant in task wire accounting", async () => {
    const { records, scenarios } = await runMatrix([0]);
    const baseline = records.find(
      (record) =>
        record.condition === "baseline" &&
        record.sourceVariant === "vulnerable",
    );
    if (!baseline) {
      throw new Error("missing baseline record");
    }
    const scenario = scenarios.find(
      (entry) => entry.scenarioId === baseline.scenarioId,
    );
    if (!scenario) {
      throw new Error("missing scenario");
    }
    expect(baseline.metrics.wireBytes).toBe(
      utf8Bytes({ source: scenario.source }),
    );
    expect(baseline.metrics.wireBytes).not.toBe(
      utf8Bytes({
        caseId: scenario.meta.id,
        class: scenario.meta.class,
        sourceVariant: scenario.sourceVariant,
        source: scenario.source,
      }),
    );
  });

  it("withholds the primary endpoint when aggregate false positives exceed the allowance", async () => {
    const { records } = await runMatrix([0]);
    const altered = records.map((record, index) =>
      index === 0
        ? {
            ...record,
            metrics: {
              ...record.metrics,
              falsePositives: records.length + 1,
              withinFpBudget: false,
            },
          }
        : record,
    );
    const condition = altered[0]?.condition;
    if (!condition) {
      throw new Error("missing condition");
    }
    const summary = summarizeSecurity(altered, FP_BUDGET);
    const endpoint = summary.conditions.find(
      (entry) => entry.condition === condition,
    );
    expect(endpoint?.aggregateWithinFpBudget).toBe(false);
    expect(endpoint?.recallAtFpBudget).toBeNull();
  });

  it("scores findings on patched variants as clean-negative false positives", async () => {
    const loaded = await loadCases(CASES_DIR);
    const cardSet = await loadPatternCards(CARDS_DIR);
    const patched = buildSecurityTrialScenarios(loaded.cases).find(
      (scenario) =>
        scenario.meta.id === "reentrancy-claim-pool" &&
        scenario.sourceVariant === "patched",
    );
    if (!patched) {
      throw new Error("missing patched scenario");
    }
    const cells = planPairedMatrix({
      experimentId: "security",
      protocolVersion: PROTOCOL_VERSION,
      scenarios: [patched],
      scenarioId: (scenario) => scenario.scenarioId,
      conditions: ["baseline" as const],
      seeds: [0],
      orderSeed: 1,
    });
    const records = await executeMatrix(cells, (cell) =>
      runSecurityTrial(cell, {
        experimentId: "security",
        referenceProvider: new FixtureReferenceProvider(),
        cards: cardSet.cards,
        cannedEntries: {
          "reentrancy-claim-pool::patched::baseline":
            "FINDING: reentrancy @ claim\nDECISION: SUBMIT\n",
        },
        provenance,
        fpBudget: FP_BUDGET,
      }),
    );

    expect(records[0]?.metrics.expectedCount).toBe(0);
    expect(records[0]?.metrics.falsePositives).toBe(1);
    expect(records[0]?.metrics.truePositives).toBe(0);
  });
});

describe("bundle validity", () => {
  it("writes a schema-valid bundle that reproduces the summary from raw records", async () => {
    const { loaded, scenarios, conditions, records } = await runMatrix([0]);
    const directory = await mkdtemp(join(tmpdir(), "security-bundle-"));
    temporaryDirectories.push(directory);

    const bundle = await writeResultBundleWith(
      directory,
      {
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        experimentId: "security",
        runId: "test-run",
        mode: "instrumentation" as const,
        evidenceClaim: "Harness validation only.",
        createdAt: new Date().toISOString(),
        orderSeed: 20_260_716,
        seeds: [0],
        conditions,
        scenarioCount: scenarios.length,
        caseCount: loaded.cases.length,
        cleanNegativeScenarioCount: loaded.cases.length,
        trainCaseCount: loaded.trainCaseCount,
        heldoutCaseCount: loaded.heldoutCaseCount,
        trialCount: records.length,
        fpBudget: FP_BUDGET,
        scorerVersion: SECURITY_SCORER_VERSION,
        scorer: {
          version: SECURITY_SCORER_VERSION,
          fingerprint: SECURITY_SCORER_FINGERPRINT,
        },
        protocolFingerprint: fingerprint({
          experiment: "security",
          test: true,
        }),
        runConfiguration: {
          mode: "instrumentation" as const,
          seeds: [0],
          orderSeed: 20_260_716,
          fpBudgetPerSource: FP_BUDGET,
          semanticBackend: "fixture" as const,
          policy: "security-instrumentation-v2-source-pairs",
          sourceVariants: ["vulnerable", "patched"] as const,
        },
        fixtureDigest: loaded.fixtureDigest,
        provenance,
        withFoundry: false,
        foundryAvailable: false,
      },
      records,
      {
        manifestSchema: securityResultManifestSchema,
        recordSchema: securityTrialRecordSchema,
        summarize: (trialRecords) => summarizeSecurity(trialRecords, FP_BUDGET),
        renderMarkdown: securitySummaryMarkdown,
      },
    );

    const trialsText = await readFile(bundle.trialsPath, "utf8");
    const lines = trialsText.trim().split("\n");
    expect(lines).toHaveLength(records.length);
    const reparsed = lines.map((line) =>
      securityTrialRecordSchema.parse(JSON.parse(line)),
    );
    const fromDisk = summarizeSecurity(reparsed, FP_BUDGET);
    const fromMemory = summarizeSecurity(records, FP_BUDGET);
    expect(fromDisk).toEqual(fromMemory);

    const summaryJson = JSON.parse(
      await readFile(bundle.summaryJsonPath, "utf8"),
    );
    expect(summaryJson).toEqual(fromMemory);

    const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"));
    expect(securityResultManifestSchema.safeParse(manifest).success).toBe(true);

    const markdown = await readFile(bundle.summaryMarkdownPath, "utf8");
    expect(markdown).toContain("Security domain trials summary");
    expect(markdown).toContain("Harness validation only");
  });
});

describe("enforced refusal in a trial", () => {
  it("refuses findings when canned output omits required digests", async () => {
    const loaded = await loadCases(CASES_DIR);
    const cardSet = await loadPatternCards(CARDS_DIR);
    const sample = buildSecurityTrialScenarios(loaded.cases).find(
      (entry) => entry.meta.id === "reentrancy-claim-pool",
    );
    if (!sample) {
      throw new Error("missing sample case");
    }

    const cells = planPairedMatrix({
      experimentId: "security",
      protocolVersion: PROTOCOL_VERSION,
      scenarios: [sample],
      scenarioId: (scenario) => scenario.scenarioId,
      conditions: ["addressed-enforced" as const],
      seeds: [0],
      orderSeed: 1,
    });

    const provider = new FixtureReferenceProvider();
    const records = await executeMatrix(cells, (cell) =>
      runSecurityTrial(cell, {
        experimentId: "security",
        referenceProvider: provider,
        cards: cardSet.cards,
        cannedEntries: {
          "reentrancy-claim-pool::addressed-enforced":
            "FINDING: reentrancy @ claim\nDECISION: SUBMIT\n",
        },
        provenance,
        fpBudget: FP_BUDGET,
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.metrics.enforcementRefused).toBe(true);
    expect(records[0]?.metrics.truePositives).toBe(0);
    expect(records[0]?.metrics.falseNegatives).toBe(1);
  });
});
