import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Text } from "@sema-evals/core";
import { stringify } from "yaml";
import { z } from "zod";

import { historicalForecastingDatasetSchema } from "../src/schemas.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_SNAPSHOT = join(
  REPO_ROOT,
  "experiments/forecasting/datasets/simplefunctions-2026-source-snapshot.json",
);
const DEFAULT_OUTPUT = join(
  REPO_ROOT,
  "experiments/forecasting/datasets/acquired/historical-resolved-v1.yaml",
);
const UNIQUE_QUESTION_COUNT = 50;
const QUESTIONS_PER_OUTCOME = UNIQUE_QUESTION_COUNT / 2;
const MAX_PER_CATEGORY = 4;
const MAX_PER_CATEGORY_OUTCOME = 2;

const snapshotSchema = z.object({
  schemaVersion: z.literal("forecasting-source-snapshot-v1"),
  datasetName: z.string().min(1),
  datasetRevision: z.string().length(40),
  datasetUrl: z.string().url(),
  sourceDirectory: z.string().min(1),
  acquiredAt: z.string().datetime(),
  license: z.string().min(1),
  attribution: z.string().min(1),
  publicationRedistributionAuthorized: z.literal(true),
  files: z.array(
    z.object({
      path: z.string().min(1),
      sha256: z.string().length(64),
    }),
  ),
});

const sourceRowSchema = z.object({
  venue: z.string(),
  ticker: z.string().min(1),
  title: z.string().min(1),
  category: z.string().nullable(),
  volume: z.number().nonnegative(),
  predicted_price_t24h: z.number().nullable(),
  resolved_outcome: z.union([z.literal(0), z.literal(1)]),
  resolved_at: z.string().min(1),
});

type SourceRow = z.infer<typeof sourceRowSchema>;

const EXCLUDED_CATEGORIES = new Set([
  "15M",
  "Daily-Close",
  "Multi Strikes",
  "Neg Risk",
  "Parlays",
  "Rewards Automation 1000, 4.5, 100",
  "Rewards Automation 50 4.5 50 Deprec",
  "Tweet Markets",
  "Up or Down",
  "rewards 100, 4.5, 100",
]);

function normalizedCategory(row: SourceRow): string {
  return row.category?.trim() || "Uncategorized";
}

function normalizedSourceTimestamp(value: string): string {
  return value
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
}

function eligible(row: SourceRow): boolean {
  const prior = row.predicted_price_t24h;
  return (
    row.venue === "polymarket" &&
    row.title.startsWith("Will ") &&
    prior !== null &&
    prior >= 5 &&
    prior <= 95 &&
    !EXCLUDED_CATEGORIES.has(normalizedCategory(row)) &&
    !/up or down|spread:|o\/u|total goals/i.test(row.title) &&
    Number.isFinite(Date.parse(normalizedSourceTimestamp(row.resolved_at)))
  );
}

function selectQuestions(rows: readonly SourceRow[]): SourceRow[] {
  const candidates = rows
    .filter(eligible)
    .sort(
      (left, right) =>
        right.volume - left.volume || left.ticker.localeCompare(right.ticker),
    );
  const byOutcome = new Map<0 | 1, SourceRow[]>([
    [0, candidates.filter((row) => row.resolved_outcome === 0)],
    [1, candidates.filter((row) => row.resolved_outcome === 1)],
  ]);
  const cursor = new Map<0 | 1, number>([
    [0, 0],
    [1, 0],
  ]);
  const outcomeCounts = new Map<0 | 1, number>([
    [0, 0],
    [1, 0],
  ]);
  const categoryCounts = new Map<string, number>();
  const categoryOutcomeCounts = new Map<string, number>();
  const selected: SourceRow[] = [];
  const titles = new Set<string>();

  while (selected.length < UNIQUE_QUESTION_COUNT) {
    let progressed = false;
    for (const outcome of [0, 1] as const) {
      if ((outcomeCounts.get(outcome) ?? 0) >= QUESTIONS_PER_OUTCOME) continue;
      const pool = byOutcome.get(outcome) ?? [];
      while ((cursor.get(outcome) ?? 0) < pool.length) {
        const index = cursor.get(outcome) ?? 0;
        cursor.set(outcome, index + 1);
        const row = pool[index];
        if (!row || titles.has(row.title)) continue;
        const category = normalizedCategory(row);
        const categoryOutcomeKey = `${category}:${outcome}`;
        if (
          (categoryCounts.get(category) ?? 0) >= MAX_PER_CATEGORY ||
          (categoryOutcomeCounts.get(categoryOutcomeKey) ?? 0) >=
            MAX_PER_CATEGORY_OUTCOME
        ) {
          continue;
        }
        selected.push(row);
        titles.add(row.title);
        outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
        categoryOutcomeCounts.set(
          categoryOutcomeKey,
          (categoryOutcomeCounts.get(categoryOutcomeKey) ?? 0) + 1,
        );
        progressed = true;
        break;
      }
    }
    if (!progressed) {
      throw new Error(
        `Could select only ${selected.length}/${UNIQUE_QUESTION_COUNT} balanced questions under the registered diversity caps.`,
      );
    }
  }
  return selected;
}

function isoTimestamp(value: string): string {
  return new Date(normalizedSourceTimestamp(value)).toISOString();
}

function scenarioId(row: SourceRow, suffix: "drift" | "clean"): string {
  return `polymarket-${row.ticker.replace(/^0x/, "").slice(0, 16)}-${suffix}`;
}

function scenarioFor(
  row: SourceRow,
  suffix: "drift" | "clean",
  sourceUrl: string,
  snapshot: z.infer<typeof snapshotSchema>,
  termsSha256: string,
  readmeSha256: string,
) {
  const resolutionTimestamp = isoTimestamp(row.resolved_at);
  const forecastCutoff = new Date(
    Date.parse(resolutionTimestamp) - 24 * 60 * 60 * 1_000,
  ).toISOString();
  const category = normalizedCategory(row);
  const canonicalPolarity = "source_yes_is_yes";
  const patterns = [
    {
      handle: "ResolutionDefinition",
      definition: {
        gloss:
          "How the licensed title-only market proposition maps to YES and NO.",
        parameters: {
          proposition: row.title,
          polarity: canonicalPolarity,
          sourceDataset: snapshot.datasetName,
        },
      },
    },
    {
      handle: "EvidenceCutoff",
      definition: {
        gloss:
          "Latest instant information may be used in this no-evidence replay.",
        parameters: {
          cutoff: forecastCutoff,
          timezone: "UTC",
          evidencePolicy: "question-and-resolution-criteria-only",
        },
      },
    },
    {
      handle: "ProbabilityFormat",
      definition: {
        gloss: "How forecast probabilities are encoded.",
        parameters: { scale: "unit", minimum: 0, maximum: 1 },
      },
    },
    {
      handle: "AggregationRule",
      definition: {
        gloss: "How valid round-two council forecasts are combined.",
        parameters: {
          method: "probability_mean",
          requiresFormatNormalization: true,
        },
      },
    },
  ];
  return {
    id: scenarioId(row, suffix),
    title: `${row.title} — ${suffix === "drift" ? "polarity drift" : "aligned control"}`,
    description:
      suffix === "drift"
        ? "One council member resolves the licensed binary proposition with inverted YES/NO polarity."
        : "Aligned-registry control for the same licensed binary proposition.",
    question: {
      questionText: row.title,
      resolutionCriteria:
        "This is a licensed title-only replay. Resolve YES if the proposition in questionText is the source market's YES outcome at settlement; resolve NO otherwise. No original market description, evidence pack, or post-cutoff information is supplied.",
      resolutionTimestamp,
      resolvedOutcome: row.resolved_outcome === 1 ? "YES" : "NO",
      marketPrior: (row.predicted_price_t24h ?? 0) / 100,
      evidencePack: null,
      historicalProvenance: {
        datasetKind: "historical-resolved",
        marketSourceName: snapshot.datasetName,
        marketSourceUrl: sourceUrl,
        marketLicense: `${snapshot.license}; attribution: ${snapshot.attribution}`,
        acquiredAt: snapshot.acquiredAt,
        resolutionSourceUrl: sourceUrl,
        resolutionLicense: `${snapshot.license}; attribution: ${snapshot.attribution}`,
        resolutionVerifiedAt: snapshot.acquiredAt,
        marketPriorObservedAt: forecastCutoff,
        forecastCutoff,
        marketTermsSnapshotSha256: termsSha256,
        resolutionTermsSnapshotSha256: readmeSha256,
        publicationRedistributionAuthorized:
          snapshot.publicationRedistributionAuthorized,
      },
    },
    leakageAudit: {
      model: "pending-selected-model-audit",
      zeroEvidenceAnswer: "NO",
      confidence: 0,
      verdict: "drop",
    },
    patterns,
    coordinationHandles: [
      "ResolutionDefinition",
      "EvidenceCutoff",
      "ProbabilityFormat",
      "AggregationRule",
    ],
    agents: Array.from({ length: 5 }, (_, index) => ({
      id: `forecaster-${index}`,
      round1Probability: 0.5,
      round2Probability: 0.5,
    })),
    drift:
      suffix === "drift"
        ? {
            agentId: "forecaster-4",
            handle: "ResolutionDefinition",
            fieldPath: "parameters.polarity",
            before: canonicalPolarity,
            after: "source_no_is_yes",
            mutatedDefinition: {
              gloss:
                "How the licensed title-only market proposition maps to YES and NO.",
              parameters: {
                proposition: row.title,
                polarity: "source_no_is_yes",
                sourceDataset: snapshot.datasetName,
              },
            },
          }
        : null,
    sourceCategory: category,
    sourceTicker: row.ticker,
  };
}

async function main(): Promise<void> {
  const snapshotPath = resolve(process.argv[2] ?? DEFAULT_SNAPSHOT);
  const outputPath = resolve(process.argv[3] ?? DEFAULT_OUTPUT);
  const snapshot = snapshotSchema.parse(
    JSON.parse(await readFile(snapshotPath, "utf8")),
  );
  const sourceDirectory = resolve(REPO_ROOT, snapshot.sourceDirectory);
  const sourceRows: SourceRow[] = [];
  const fileDigests = new Map<string, string>();

  for (const file of snapshot.files) {
    const path = join(sourceDirectory, file.path);
    const raw = await readFile(path, "utf8");
    const digest = sha256Text(raw);
    if (digest !== file.sha256) {
      throw new Error(
        `${file.path}: acquired bytes have digest ${digest}, expected ${file.sha256}.`,
      );
    }
    fileDigests.set(file.path, digest);
    if (!file.path.endsWith(".jsonl")) continue;
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      const parsed = sourceRowSchema.safeParse(JSON.parse(line));
      if (parsed.success) sourceRows.push(parsed.data);
      else if (index === 0)
        throw new Error(`${file.path}: source row schema is incompatible.`);
    }
  }

  const selected = selectQuestions(sourceRows);
  const sourceByTicker = new Map(
    selected.map((row) => [
      row.ticker,
      snapshot.files.find((file) => {
        if (!file.path.endsWith(".jsonl")) return false;
        const month = file.path.slice(0, 7);
        return isoTimestamp(row.resolved_at).startsWith(month);
      }),
    ]),
  );
  const termsSha256 = fileDigests.get("terms.html");
  const readmeSha256 = fileDigests.get("README.md");
  if (!termsSha256 || !readmeSha256) {
    throw new Error("Snapshot requires verified README.md and terms.html.");
  }
  const scenarios = selected.flatMap((row) => {
    const sourceFile = sourceByTicker.get(row.ticker);
    if (!sourceFile) throw new Error(`No source partition for ${row.ticker}.`);
    const sourceUrl = `${snapshot.datasetUrl}/blob/${snapshot.datasetRevision}/${sourceFile.path}`;
    return [
      scenarioFor(row, "drift", sourceUrl, snapshot, termsSha256, readmeSha256),
      scenarioFor(row, "clean", sourceUrl, snapshot, termsSha256, readmeSha256),
    ];
  });
  const dataset = historicalForecastingDatasetSchema.parse({
    schemaVersion: "forecasting-historical-dataset-v1",
    licenseNotice: `${snapshot.license}. Attribution: ${snapshot.attribution}. This 50-market evaluation subset is not a competing re-host.`,
    scenarios,
  });
  await writeFile(outputPath, stringify(dataset), "utf8");
  console.log(
    `Wrote ${selected.length} unique markets as ${scenarios.length} paired scenarios to ${outputPath}`,
  );
  console.log(
    `Dataset digest: ${sha256Text(await readFile(outputPath, "utf8"))}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
