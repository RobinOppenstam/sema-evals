import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createModelProvider } from "@sema-evals/adapters";
import { fingerprint, sha256Text } from "@sema-evals/core";
import { parse } from "yaml";
import { z } from "zod";

import {
  LEAKAGE_AUDIT_PROTOCOL_FINGERPRINT,
  loadHistoricalForecastingDataset,
} from "../src/model-readiness.js";
import {
  historicalForecastingDatasetSchema,
  leakageAuditDocumentSchema,
  resolvedOutcomeSchema,
} from "../src/schemas.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const auditOutputSchema = z.object({
  answer: resolvedOutcomeSchema,
  confidence: z.number().min(0).max(1),
  basis: z.string().min(1),
});

interface Options {
  datasetPath: string;
  outputPath: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  concurrency: number;
}

function parseArgs(args: readonly string[]): Options {
  const options: Options = {
    datasetPath: resolve(
      REPO_ROOT,
      "experiments/forecasting/datasets/acquired/historical-resolved-v1.yaml",
    ),
    outputPath: resolve(
      REPO_ROOT,
      "experiments/forecasting/datasets/acquired/mistral-nemo-2407-leakage-audit.json",
    ),
    baseUrl: "https://llm.chutes.ai/v1",
    model: "unsloth/Mistral-Nemo-Instruct-2407-TEE",
    apiKeyEnv: "CHUTES_API_KEY",
    concurrency: 8,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") continue;
    const value = args[++index];
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === "--dataset") options.datasetPath = resolve(value);
    else if (flag === "--output") options.outputPath = resolve(value);
    else if (flag === "--base-url") options.baseUrl = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--api-key-env") options.apiKeyEnv = value;
    else if (flag === "--concurrency") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0)
        throw new Error("--concurrency requires a positive integer.");
      options.concurrency = parsed;
    } else throw new Error(`Unknown flag: ${flag}.`);
  }
  return options;
}

const SYSTEM_PROMPT =
  'You are performing a zero-evidence contamination screen for a historical forecasting replay. Use only the question and resolution criteria supplied. You have no tools or evidence. Return exactly one JSON object: {"answer":"YES"|"NO","confidence":number from 0 through 1,"basis":"short explanation using no post-cutoff facts"}.';

function logChoose(n: number, k: number): number {
  let value = 0;
  for (let index = 1; index <= k; index += 1) {
    value += Math.log(n - k + index) - Math.log(index);
  }
  return value;
}

function oneSidedBinomialPValue(correct: number, total: number): number {
  if (total === 0) return 1;
  let sum = 0;
  for (let value = correct; value <= total; value += 1) {
    sum += Math.exp(logChoose(total, value) - total * Math.log(2));
  }
  return Math.min(1, sum);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const key = process.env[options.apiKeyEnv];
  if (!key) throw new Error(`${options.apiKeyEnv} is required.`);
  const validated = await loadHistoricalForecastingDataset(options.datasetPath);
  const rawDataset = historicalForecastingDatasetSchema.parse(
    parse(await readFile(options.datasetPath, "utf8")),
  );
  const provider = createModelProvider({
    provider: "openai-compatible",
    systemPrompt: SYSTEM_PROMPT,
    model: options.model,
    maxTokens: 256,
    thinking: "none",
    baseUrl: options.baseUrl,
    apiKeyEnv: options.apiKeyEnv,
  });
  const providerLabel = await provider.providerLabel();
  const modelDescriptor = `${providerLabel}/${options.model}`;
  const byQuestion = new Map<string, (typeof rawDataset.scenarios)[number][]>();
  for (const scenario of rawDataset.scenarios) {
    const key = fingerprint({
      questionText: scenario.question.questionText,
      resolutionCriteria: scenario.question.resolutionCriteria,
    });
    byQuestion.set(key, [...(byQuestion.get(key) ?? []), scenario]);
  }
  const questions = [...byQuestion.values()];
  const audited = new Array<{
    scenarios: (typeof rawDataset.scenarios)[number][];
    parsed: z.infer<typeof auditOutputSchema> | null;
    rawOutput: string;
    transcript: Awaited<
      ReturnType<typeof provider.adapter.invoke>
    >["transcript"];
    usage: Awaited<ReturnType<typeof provider.adapter.invoke>>["usage"];
    promptFingerprint: string;
  }>();
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const scenarios = questions[index];
      if (!scenarios) return;
      const representative = scenarios[0];
      if (!representative) throw new Error("Empty question group.");
      const prompt = JSON.stringify({
        question: representative.question.questionText,
        resolutionCriteria: representative.question.resolutionCriteria,
        evidence: null,
      });
      const completion = await provider.adapter.invoke({
        messages: [{ role: "user", content: prompt }],
      });
      let parsed: z.infer<typeof auditOutputSchema> | null = null;
      try {
        parsed = auditOutputSchema.parse(JSON.parse(completion.output.text));
      } catch {
        parsed = null;
      }
      audited.push({
        scenarios,
        parsed,
        rawOutput: completion.output.text,
        transcript: completion.transcript,
        usage: completion.usage,
        promptFingerprint: sha256Text(`${SYSTEM_PROMPT}\n${prompt}`),
      });
      console.log(
        `${index + 1}/${questions.length} ${representative.id}: ${parsed ? "parsed" : "malformed"}`,
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, questions.length) },
      worker,
    ),
  );
  const parsedAudits = audited.filter((item) => item.parsed !== null);
  const correctAnswers = parsedAudits.filter((item) => {
    const representative = item.scenarios[0];
    return (
      representative !== undefined &&
      item.parsed?.answer === representative.question.resolvedOutcome
    );
  }).length;
  const pValue = oneSidedBinomialPValue(correctAnswers, parsedAudits.length);
  const alpha = 0.01;
  const passed =
    parsedAudits.length >= Math.ceil(questions.length * 0.9) && pValue >= alpha;
  const entries = audited.flatMap((item) =>
    item.scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      audit: {
        model: options.model,
        zeroEvidenceAnswer: item.parsed?.answer ?? "NO",
        confidence: item.parsed?.confidence ?? 0,
        verdict: passed ? ("keep" as const) : ("drop" as const),
        modelDescriptor,
        promptFingerprint: item.promptFingerprint,
        auditedAt: new Date().toISOString(),
        evidenceExcluded: true as const,
        rawOutput: item.rawOutput,
        modelRevision:
          "Mistral-Nemo-Instruct-2407 served by Chutes; exact provider/model descriptor bound above.",
        trainingCutoff:
          "Not disclosed by model card; upstream model was released in July 2024 and every audited market resolved in 2026.",
        reviewer: "deterministic-temporal-binomial-leakage-policy-v2",
        rationale: passed
          ? `Kept under the registered dataset-level screen: ${correctAnswers}/${parsedAudits.length} parsed answers correct, one-sided exact binomial p=${pValue.toPrecision(6)}; model release predates every outcome.`
          : `Dropped because the registered dataset-level screen failed: ${correctAnswers}/${parsedAudits.length} parsed answers correct, one-sided exact binomial p=${pValue.toPrecision(6)}, parse completeness ${parsedAudits.length}/${questions.length}.`,
        auditStatus:
          item.parsed === null ? ("malformed" as const) : ("parsed" as const),
        transcript: item.transcript,
        usage: item.usage,
      },
    })),
  );
  entries.sort((left, right) =>
    left.scenarioId.localeCompare(right.scenarioId),
  );
  const document = leakageAuditDocumentSchema.parse({
    schemaVersion: "forecasting-model-leakage-audit-v1",
    modelDescriptor,
    datasetDigest: validated.digest,
    protocolFingerprint: LEAKAGE_AUDIT_PROTOCOL_FINGERPRINT,
    zeroEvidencePrompt: SYSTEM_PROMPT,
    aggregate: {
      uniqueQuestions: questions.length,
      parsedQuestions: parsedAudits.length,
      correctAnswers,
      accuracy:
        parsedAudits.length === 0 ? 0 : correctAnswers / parsedAudits.length,
      oneSidedBinomialPValue: pValue,
      alpha,
      passed,
    },
    entries,
  });
  await writeFile(
    options.outputPath,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `Wrote ${document.entries.length} scenario audits: ${correctAnswers}/${parsedAudits.length} correct, p=${pValue.toPrecision(6)}, gate=${passed ? "PASSED" : "FAILED"} to ${options.outputPath}`,
  );
  if (!passed) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
