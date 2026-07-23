import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LEAKAGE_AUDIT_PROTOCOL_FINGERPRINT,
  evaluateModelLeakageAudit,
  loadHistoricalForecastingDataset,
} from "../src/model-readiness.js";

const expected = {
  modelDescriptor: "llm.chutes.ai/example-model",
  datasetDigest: "a".repeat(64),
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function dataset(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "forecasting-historical-dataset-v1",
    licenseNotice: "authorized local acquisition",
    scenarios: [
      {
        id: "market-a",
        title: "t",
        description: "d",
        question: {
          questionText: "Will A occur?",
          resolutionCriteria: "YES if A occurs.",
          resolutionTimestamp: "2024-02-01T00:00:00.000Z",
          resolvedOutcome: "YES",
          marketPrior: 0.5,
          evidencePack: null,
          historicalProvenance: {
            datasetKind: "historical-resolved",
            marketSourceName: "authorized source",
            marketSourceUrl: "https://example.com/market-a",
            marketLicense: "licensed",
            acquiredAt: "2024-03-01T00:00:00.000Z",
            resolutionSourceUrl: "https://example.com/resolution-a",
            resolutionLicense: "licensed",
            resolutionVerifiedAt: "2024-03-01T00:00:00.000Z",
            marketPriorObservedAt: "2024-01-01T00:00:00.000Z",
            forecastCutoff: "2024-01-15T00:00:00.000Z",
            marketTermsSnapshotSha256: "a".repeat(64),
            resolutionTermsSnapshotSha256: "b".repeat(64),
            publicationRedistributionAuthorized: true,
          },
        },
        leakageAudit: {
          model: "pending",
          zeroEvidenceAnswer: "NO",
          confidence: 0,
          verdict: "drop",
        },
        patterns: [
          { handle: "ResolutionDefinition", definition: { x: 1 } },
          { handle: "EvidenceCutoff", definition: { x: 1 } },
          { handle: "ProbabilityFormat", definition: { x: 1 } },
          { handle: "AggregationRule", definition: { x: 1 } },
        ],
        coordinationHandles: [
          "ResolutionDefinition",
          "EvidenceCutoff",
          "ProbabilityFormat",
          "AggregationRule",
        ],
        agents: [
          { id: "a", round1Probability: 0.5, round2Probability: 0.5 },
          { id: "b", round1Probability: 0.5, round2Probability: 0.5 },
        ],
        drift: null,
      },
    ],
    ...overrides,
  };
}

async function writeDataset(value: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forecasting-dataset-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "dataset.yaml");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

describe("model-pilot readiness", () => {
  it("requires a valid forecast cutoff and the registered no-evidence arm", async () => {
    const badCutoff = dataset();
    const question = (
      badCutoff.scenarios as {
        question: { historicalProvenance: { forecastCutoff: string } };
      }[]
    )[0]!.question;
    question.historicalProvenance.forecastCutoff = "2024-02-01T00:00:00.000Z";
    await expect(
      loadHistoricalForecastingDataset(await writeDataset(badCutoff)),
    ).rejects.toThrow(
      /marketPriorObservedAt <= forecastCutoff < resolutionTimestamp/,
    );

    const withEvidence = dataset();
    const evidenceQuestion = (
      withEvidence.scenarios as { question: { evidencePack: unknown } }[]
    )[0]!.question;
    evidenceQuestion.evidencePack = {
      schemaVersion: "forecasting-evidence-pack-v1",
      cutoff: "2024-01-01T00:00:00.000Z",
      items: [
        {
          id: "future-arm-only",
          sourceName: "source",
          sourceUrl: "https://example.com/evidence",
          license: "licensed",
          publishedAt: "2024-01-01T00:00:00.000Z",
          retrievedAt: "2024-01-01T00:00:00.000Z",
          frozenPath: "not-read-in-no-evidence-pilot.txt",
          sha256: "c".repeat(64),
          summary: "not used",
        },
      ],
    };
    await expect(
      loadHistoricalForecastingDataset(await writeDataset(withEvidence)),
    ).rejects.toThrow(/no-evidence/);
  });

  it("rejects a dataset without explicit publication authorization", async () => {
    const unauthorized = dataset();
    const provenance = (
      unauthorized.scenarios as {
        question: {
          historicalProvenance: {
            publicationRedistributionAuthorized: boolean;
          };
        };
      }[]
    )[0]!.question.historicalProvenance;
    provenance.publicationRedistributionAuthorized = false;
    await expect(
      loadHistoricalForecastingDataset(await writeDataset(unauthorized)),
    ).rejects.toThrow(/publicationRedistributionAuthorized/);
  });

  it("requires a selected-model, dataset-bound, zero-evidence audit for every question", () => {
    const valid = evaluateModelLeakageAudit(
      {
        schemaVersion: "forecasting-model-leakage-audit-v1",
        modelDescriptor: expected.modelDescriptor,
        datasetDigest: expected.datasetDigest,
        protocolFingerprint: LEAKAGE_AUDIT_PROTOCOL_FINGERPRINT,
        zeroEvidencePrompt:
          "Question and resolution criteria only; no evidence material.",
        entries: [
          {
            scenarioId: "market-a",
            audit: {
              model: "example-model",
              modelDescriptor: expected.modelDescriptor,
              zeroEvidenceAnswer: "NO",
              confidence: 0.55,
              verdict: "keep",
              promptFingerprint: "c".repeat(64),
              auditedAt: "2024-01-01T00:00:00.000Z",
              evidenceExcluded: true,
              rawOutput: '{\\"probability\\":0.55}',
              modelRevision: "provider-published-revision",
              trainingCutoff: "unknown-not-claimed",
              reviewer: "named-human-reviewer",
              rationale:
                "No high-confidence answer attributable to post-cutoff knowledge.",
              transcript: { entries: [] },
            },
          },
        ],
      },
      expected,
      ["market-a"],
    );
    expect(valid.passed).toBe(true);

    const wrongProtocol = evaluateModelLeakageAudit(
      {
        schemaVersion: "forecasting-model-leakage-audit-v1",
        modelDescriptor: expected.modelDescriptor,
        datasetDigest: expected.datasetDigest,
        protocolFingerprint: "b".repeat(64),
        zeroEvidencePrompt:
          "Question and resolution criteria only; no evidence material.",
        entries: [],
      },
      expected,
      [],
    );
    expect(wrongProtocol.passed).toBe(false);
    expect(wrongProtocol.failures.join(" ")).toMatch(
      /wrong protocol fingerprint/,
    );

    const wrongModel = evaluateModelLeakageAudit(
      {
        schemaVersion: "forecasting-model-leakage-audit-v1",
        modelDescriptor: "other/model",
        datasetDigest: expected.datasetDigest,
        entries: [],
      },
      expected,
      ["market-a"],
    );
    expect(wrongModel.passed).toBe(false);
    expect(wrongModel.failures.join(" ")).toMatch(/selected provider/);
  });
});
