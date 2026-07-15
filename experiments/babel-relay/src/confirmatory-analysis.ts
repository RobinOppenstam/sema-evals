// -------------------------------------------------------------------------
// Confirmatory analysis for preregistration 001.
//
// Reads one result bundle per model arm and computes the exact endpoints and
// interval tests fixed in §2 of the preregistration:
//   H1  addressing detects drift  — Clopper–Pearson upper bound <= 5%
//   H2  enforcement converts to outcomes — Newcombe difference lower bound > 15pp
//   H3  the baseline problem is real — Wilson lower bound > 50%
// plus the §2 secondary descriptive effects (no pass/fail), the §9 exclusion
// accounting and 2% infrastructure-invalid flag, per-model verdicts, and the
// conjunctive experiment verdict.
//
// Everything here is deterministic and depends only on the frozen trial records
// and the interval math in ./stats.ts — the analysis script is part of the
// registered commit.
// -------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EXPERIMENT_CONDITIONS,
  resultManifestSchema,
  trialRecordSchema,
  type ExperimentCondition,
  type TrialRecord,
} from "@sema-evals/core";

import {
  clopperPearsonInterval,
  newcombeDifferenceInterval,
  wilsonInterval,
  type Interval,
} from "./stats.js";

// --- Registered thresholds (preregistration 001 §2 / §9) ---
export const H1_MAX_UPPER = 0.05;
export const H2_MIN_LOWER_DIFF = 0.15;
export const H3_MIN_LOWER = 0.5;
export const EXCLUSION_INVALID_RATE = 0.02;

const ADDRESSED_ARMS = [
  "addressed-voluntary",
  "addressed-enforced",
] as const satisfies readonly ExperimentCondition[];

export interface HypothesisCheck {
  id: "H1" | "H2" | "H3";
  label: string;
  condition?: string;
  method: string;
  threshold: string;
  numerator: number;
  denominator: number;
  pointEstimate: number;
  interval: Interval;
  pass: boolean;
}

export interface DescriptiveEffect {
  id: string;
  label: string;
  difference: number;
  interval: Interval;
  method: "newcombe-hybrid-score";
}

export interface FalseHaltRate {
  condition: ExperimentCondition;
  falseHalts: number;
  trials: number;
  rate: number;
  interval: Interval;
}

export interface ExclusionAccounting {
  totalTrials: number;
  excluded: number;
  excludedRate: number;
  byCondition: Record<string, number>;
  infrastructureInvalid: boolean;
}

export interface ModelAnalysis {
  arm: string;
  mode: string;
  exclusions: ExclusionAccounting;
  hypotheses: HypothesisCheck[];
  descriptive: DescriptiveEffect[];
  falseHalts: FalseHaltRate[];
  confirmed: boolean;
  failures: string[];
}

export interface ConfirmatoryReport {
  sources: string[];
  models: ModelAnalysis[];
  verdict: "confirmed" | "partial" | "refuted";
  verdictDetail: string;
}

export interface ArmInput {
  arm: string;
  mode: string;
  trials: readonly TrialRecord[];
}

/**
 * A trial is excluded (§9) when any hop exhausted provider retries. The relay
 * records this on the terminal `completion` event as `hopFailed: true`. Trials
 * that halted under enforcement before any model hop emit no completion event
 * and are never hop-failed.
 */
export function trialHopFailed(record: TrialRecord): boolean {
  return record.events.some(
    (event) => event.type === "completion" && event.details.hopFailed === true,
  );
}

interface ConditionCounts {
  trials: number;
  driftTrials: number;
  silentDivergences: number;
  taskSuccesses: number;
  falseHalts: number;
}

function countCondition(
  trials: readonly TrialRecord[],
  condition: ExperimentCondition,
): ConditionCounts {
  const rows = trials.filter((trial) => trial.condition === condition);
  const drift = rows.filter((trial) => trial.metrics.driftInjected);
  return {
    trials: rows.length,
    driftTrials: drift.length,
    silentDivergences: drift.filter((trial) => trial.metrics.silentDivergence)
      .length,
    taskSuccesses: rows.filter((trial) => trial.metrics.taskSuccess).length,
    falseHalts: rows.filter((trial) => trial.metrics.falseHalt).length,
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Analyzes a single model arm. Pure: no IO, deterministic in its inputs. */
export function analyzeArm(input: ArmInput): ModelAnalysis {
  const totalTrials = input.trials.length;
  const excludedTrials = input.trials.filter(trialHopFailed);
  const endpointTrials = input.trials.filter((trial) => !trialHopFailed(trial));

  const byConditionExcluded: Record<string, number> = {};
  for (const trial of excludedTrials) {
    byConditionExcluded[trial.condition] =
      (byConditionExcluded[trial.condition] ?? 0) + 1;
  }
  const excludedRate = rate(excludedTrials.length, totalTrials);
  const exclusions: ExclusionAccounting = {
    totalTrials,
    excluded: excludedTrials.length,
    excludedRate,
    byCondition: byConditionExcluded,
    infrastructureInvalid: excludedRate > EXCLUSION_INVALID_RATE,
  };

  const counts = new Map<ExperimentCondition, ConditionCounts>();
  for (const condition of EXPERIMENT_CONDITIONS) {
    counts.set(condition, countCondition(endpointTrials, condition));
  }
  const get = (condition: ExperimentCondition): ConditionCounts =>
    counts.get(condition) ?? {
      trials: 0,
      driftTrials: 0,
      silentDivergences: 0,
      taskSuccesses: 0,
      falseHalts: 0,
    };

  const hypotheses: HypothesisCheck[] = [];

  // H1: per addressed arm, silent-divergence Clopper–Pearson upper bound <= 5%.
  for (const arm of ADDRESSED_ARMS) {
    const c = get(arm);
    const interval = clopperPearsonInterval(c.silentDivergences, c.driftTrials);
    hypotheses.push({
      id: "H1",
      label: "Addressing detects drift",
      condition: arm,
      method: "clopper-pearson-exact",
      threshold: `upper <= ${H1_MAX_UPPER}`,
      numerator: c.silentDivergences,
      denominator: c.driftTrials,
      pointEstimate: rate(c.silentDivergences, c.driftTrials),
      interval,
      pass: c.driftTrials > 0 && interval.upper <= H1_MAX_UPPER,
    });
  }

  // H2: enforced - voluntary task-success Newcombe difference, lower > 15pp.
  const enforced = get("addressed-enforced");
  const voluntary = get("addressed-voluntary");
  const h2Interval = newcombeDifferenceInterval(
    enforced.taskSuccesses,
    enforced.trials,
    voluntary.taskSuccesses,
    voluntary.trials,
  );
  hypotheses.push({
    id: "H2",
    label: "Enforcement converts detection into outcomes",
    condition: "addressed-enforced - addressed-voluntary",
    method: "newcombe-hybrid-score",
    threshold: `lower > ${H2_MIN_LOWER_DIFF}`,
    numerator: enforced.taskSuccesses - voluntary.taskSuccesses,
    denominator: enforced.trials,
    pointEstimate:
      rate(enforced.taskSuccesses, enforced.trials) -
      rate(voluntary.taskSuccesses, voluntary.trials),
    interval: h2Interval,
    pass: h2Interval.lower > H2_MIN_LOWER_DIFF,
  });

  // H3: baseline silent-divergence Wilson lower bound > 50%.
  const baseline = get("baseline");
  const h3Interval = wilsonInterval(
    baseline.silentDivergences,
    baseline.driftTrials,
  );
  hypotheses.push({
    id: "H3",
    label: "The baseline problem is real",
    condition: "baseline",
    method: "wilson-score",
    threshold: `lower > ${H3_MIN_LOWER}`,
    numerator: baseline.silentDivergences,
    denominator: baseline.driftTrials,
    pointEstimate: rate(baseline.silentDivergences, baseline.driftTrials),
    interval: h3Interval,
    pass: baseline.driftTrials > 0 && h3Interval.lower > H3_MIN_LOWER,
  });

  // Secondary descriptive effects (task-success differences), no pass/fail.
  const descriptive: DescriptiveEffect[] = [
    describeEffect(
      "content-effect",
      "Content effect (equal-prose - baseline)",
      get("equal-prose"),
      get("baseline"),
    ),
    describeEffect(
      "lookup-effect",
      "Lookup effect (opaque-resolver - equal-prose)",
      get("opaque-resolver"),
      get("equal-prose"),
    ),
    describeEffect(
      "detection-alone-effect",
      "Detection-alone effect (addressed-voluntary - equal-prose)",
      get("addressed-voluntary"),
      get("equal-prose"),
    ),
  ];

  const falseHalts: FalseHaltRate[] = EXPERIMENT_CONDITIONS.map((condition) => {
    const c = get(condition);
    return {
      condition,
      falseHalts: c.falseHalts,
      trials: c.trials,
      rate: rate(c.falseHalts, c.trials),
      interval: wilsonInterval(c.falseHalts, c.trials),
    };
  });

  const failures: string[] = [];
  for (const check of hypotheses) {
    if (!check.pass) {
      failures.push(describeFailure(check));
    }
  }
  if (exclusions.infrastructureInvalid) {
    failures.push(
      `infrastructure-invalid: ${exclusions.excluded}/${exclusions.totalTrials} ` +
        `trials excluded (${(excludedRate * 100).toFixed(2)}% > ${(
          EXCLUSION_INVALID_RATE * 100
        ).toFixed(0)}%); arm must be rerun`,
    );
  }

  return {
    arm: input.arm,
    mode: input.mode,
    exclusions,
    hypotheses,
    descriptive,
    falseHalts,
    confirmed: failures.length === 0,
    failures,
  };
}

function describeEffect(
  id: string,
  label: string,
  group1: ConditionCounts,
  group2: ConditionCounts,
): DescriptiveEffect {
  return {
    id,
    label,
    difference:
      rate(group1.taskSuccesses, group1.trials) -
      rate(group2.taskSuccesses, group2.trials),
    interval: newcombeDifferenceInterval(
      group1.taskSuccesses,
      group1.trials,
      group2.taskSuccesses,
      group2.trials,
    ),
    method: "newcombe-hybrid-score",
  };
}

function describeFailure(check: HypothesisCheck): string {
  const where = check.condition ? ` (${check.condition})` : "";
  if (check.id === "H2") {
    return `${check.id}${where}: difference lower bound ${pp(
      check.interval.lower,
    )} not > ${pp(H2_MIN_LOWER_DIFF)}`;
  }
  if (check.id === "H3") {
    return `${check.id}${where}: silent-divergence lower bound ${pp(
      check.interval.lower,
    )} not > ${pp(H3_MIN_LOWER)}`;
  }
  return `${check.id}${where}: silent-divergence upper bound ${pp(
    check.interval.upper,
  )} not <= ${pp(H1_MAX_UPPER)}`;
}

/** Combines per-arm analyses into the conjunctive experiment verdict (§11). */
export function analyzeReport(
  sources: readonly string[],
  arms: readonly ArmInput[],
): ConfirmatoryReport {
  const models = arms.map(analyzeArm);
  const confirmed = models.filter((model) => model.confirmed).length;
  let verdict: ConfirmatoryReport["verdict"];
  let verdictDetail: string;
  if (models.length > 0 && confirmed === models.length) {
    verdict = "confirmed";
    verdictDetail = `All ${models.length} model arm(s) confirmed every hypothesis.`;
  } else if (confirmed > 0) {
    verdict = "partial";
    const failing = models
      .filter((model) => !model.confirmed)
      .map((model) => `${model.arm} [${model.failures.join("; ")}]`);
    verdictDetail = `${confirmed} of ${models.length} model arm(s) confirmed. Not confirmed: ${failing.join(" | ")}.`;
  } else {
    verdict = "refuted";
    const failing = models.map(
      (model) => `${model.arm} [${model.failures.join("; ")}]`,
    );
    verdictDetail = `No model arm confirmed all hypotheses. ${failing.join(" | ")}.`;
  }
  return { sources: [...sources], models, verdict, verdictDetail };
}

// --- Rendering ---

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Percentage-point rendering for differences (signed). */
function pp(value: number): string {
  const points = value * 100;
  const sign = points >= 0 ? "+" : "";
  return `${sign}${points.toFixed(1)}pp`;
}

function interval(iv: Interval): string {
  return `[${pct(iv.lower)}, ${pct(iv.upper)}]`;
}

function intervalPP(iv: Interval): string {
  return `[${pp(iv.lower)}, ${pp(iv.upper)}]`;
}

function renderModel(model: ModelAnalysis): string {
  const lines: string[] = [];
  lines.push(`## Model arm: ${model.arm}`);
  lines.push("");
  lines.push(`- Mode: ${model.mode}`);
  lines.push(
    `- Exclusions (hopFailed): ${model.exclusions.excluded}/${model.exclusions.totalTrials} ` +
      `(${(model.exclusions.excludedRate * 100).toFixed(2)}%)` +
      (model.exclusions.infrastructureInvalid
        ? " — INFRASTRUCTURE-INVALID (> 2%); arm must be rerun"
        : ""),
  );
  const exclusionBreakdown = Object.entries(model.exclusions.byCondition)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([condition, n]) => `${condition}=${n}`)
    .join(", ");
  if (exclusionBreakdown) {
    lines.push(`- Excluded by condition: ${exclusionBreakdown}`);
  }
  lines.push(
    `- Verdict: ${model.confirmed ? "CONFIRMED" : "NOT CONFIRMED"}` +
      (model.failures.length > 0 ? ` (${model.failures.join("; ")})` : ""),
  );
  lines.push("");
  lines.push("### Primary hypotheses");
  lines.push("");
  lines.push(
    "Hypothesis | Condition | Estimate | 95% interval | Method | Threshold | Result",
  );
  lines.push("--- | --- | ---: | --- | --- | --- | ---");
  for (const check of model.hypotheses) {
    const estimate =
      check.id === "H2"
        ? `${pp(check.pointEstimate)} (${check.numerator}/${check.denominator})`
        : `${pct(check.pointEstimate)} (${check.numerator}/${check.denominator})`;
    const iv =
      check.id === "H2" ? intervalPP(check.interval) : interval(check.interval);
    lines.push(
      [
        `${check.id} ${check.label}`,
        check.condition ?? "",
        estimate,
        iv,
        check.method,
        check.threshold,
        check.pass ? "PASS" : "FAIL",
      ].join(" | "),
    );
  }
  lines.push("");
  lines.push("### Secondary descriptive effects (no pass/fail)");
  lines.push("");
  lines.push("Effect | Difference | 95% interval (Newcombe)");
  lines.push("--- | ---: | ---");
  for (const effect of model.descriptive) {
    lines.push(
      [effect.label, pp(effect.difference), intervalPP(effect.interval)].join(
        " | ",
      ),
    );
  }
  lines.push("");
  lines.push("False-halt rates (Wilson):");
  lines.push("");
  lines.push("Condition | False halts | Rate | 95% interval");
  lines.push("--- | ---: | ---: | ---");
  for (const fh of model.falseHalts) {
    lines.push(
      [
        fh.condition,
        `${fh.falseHalts}/${fh.trials}`,
        pct(fh.rate),
        interval(fh.interval),
      ].join(" | "),
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderReportMarkdown(report: ConfirmatoryReport): string {
  const lines: string[] = [];
  lines.push("# Babel Relay confirmatory analysis (preregistration 001)");
  lines.push("");
  lines.push(`Experiment verdict: **${report.verdict.toUpperCase()}**`);
  lines.push("");
  lines.push(report.verdictDetail);
  lines.push("");
  lines.push(`Analyzed ${report.models.length} model arm(s) from:`);
  for (const source of report.sources) {
    lines.push(`- ${source}`);
  }
  lines.push("");
  for (const model of report.models) {
    lines.push(renderModel(model));
  }
  return `${lines.join("\n")}\n`;
}

// --- IO / CLI ---

function parseTrials(source: string): TrialRecord[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => trialRecordSchema.parse(JSON.parse(line)));
}

export async function loadArm(bundleDir: string): Promise<ArmInput> {
  const manifest = resultManifestSchema.parse(
    JSON.parse(await readFile(join(bundleDir, "manifest.json"), "utf8")),
  );
  const trials = parseTrials(
    await readFile(join(bundleDir, "trials.jsonl"), "utf8"),
  );
  return {
    arm: manifest.provenance.modelName,
    mode: manifest.mode,
    trials,
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const bundleDirs = argv.filter(
    (arg) => arg !== "--" && !arg.startsWith("--"),
  );
  const emitJson = argv.includes("--json");
  if (bundleDirs.length === 0) {
    console.error(
      "Usage: pnpm --filter @sema-evals/babel-relay run analyze -- <bundleDir>... [--json]",
    );
    process.exitCode = 1;
    return;
  }
  const arms = await Promise.all(bundleDirs.map(loadArm));
  const report = analyzeReport(bundleDirs, arms);
  if (emitJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(renderReportMarkdown(report));
  }
  if (report.verdict === "refuted") {
    process.exitCode = 2;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
