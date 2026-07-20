import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hookEnforcementAdapter } from "../lib/adapters/hook-relay.js";
import { registeredExperimentIds } from "../lib/experiment-adapter.js";

const RUN_ID = "20260720T120000000Z-test-run";

function makeTrial(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    trial_id: "off-scenario-r0",
    condition: "off",
    scenario_id: "scenario-a",
    rep: 0,
    expected_action: "halt",
    actual_action: "proceed",
    drift_injected: true,
    drift_detected: false,
    gate_detected: false,
    enforcement_halted: false,
    audit_decision: "proceed",
    silent_divergence: true,
    false_halt: false,
    task_success: false,
    hop_failed: false,
    hops_run: 3,
    seconds: 48.4,
    ...overrides,
  };
}

function makeManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    experimentId: "hook-enforcement",
    runId: RUN_ID,
    mode: "exploratory",
    createdAt: "2026-07-20T12:00:00.000Z",
    evidenceClaim: "Exploratory hook pilot. Not confirmatory evidence.",
    provenance: {
      harness: "Claude Code",
      harnessVersion: "1.0.0",
      model: "anthropic/claude-3-5-haiku",
      gateIntegration: "hook",
      gateSource: "UserPromptSubmit",
      recordsPath: "experiments/babel-hook/records/test",
    },
    deviations: [],
    ...overrides,
  };
}

function aggregateFromTrials(
  trials: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const conditions = ["off", "warn", "enforce"] as const;
  const summaryConditions: Record<string, Record<string, number>> = {};
  for (const condition of conditions) {
    const inCondition = trials.filter((trial) => trial.condition === condition);
    const driftInjected = inCondition.filter(
      (trial) => trial.drift_injected === true,
    );
    summaryConditions[condition] = {
      trials: inCondition.length,
      drift_trials: driftInjected.length,
      detection: driftInjected.filter((trial) => trial.drift_detected === true)
        .length,
      silent_divergence: driftInjected.filter(
        (trial) => trial.silent_divergence === true,
      ).length,
      drift_halted: driftInjected.filter(
        (trial) => trial.actual_action === "halt",
      ).length,
      task_success: inCondition.filter((trial) => trial.task_success === true)
        .length,
      false_halts: inCondition.filter((trial) => trial.false_halt === true)
        .length,
      malformed: inCondition.filter(
        (trial) => trial.audit_decision === "malformed",
      ).length,
      hop_failed: inCondition.filter((trial) => trial.hop_failed === true)
        .length,
    };
  }
  return { conditions: summaryConditions };
}

const SYNTHETIC_TRIALS = [
  makeTrial({
    trial_id: "off-a-r0",
    condition: "off",
    drift_injected: true,
    drift_detected: false,
    silent_divergence: true,
    actual_action: "proceed",
    task_success: false,
  }),
  makeTrial({
    trial_id: "warn-a-r0",
    condition: "warn",
    drift_injected: true,
    drift_detected: true,
    gate_detected: true,
    silent_divergence: false,
    actual_action: "halt",
    audit_decision: "halt",
    task_success: true,
  }),
  makeTrial({
    trial_id: "enforce-a-r0",
    condition: "enforce",
    drift_injected: true,
    drift_detected: true,
    gate_detected: true,
    enforcement_halted: true,
    silent_divergence: false,
    actual_action: "halt",
    audit_decision: null,
    task_success: true,
    hops_run: 0,
  }),
  makeTrial({
    trial_id: "enforce-a-r1",
    condition: "enforce",
    scenario_id: "scenario-a",
    rep: 1,
    drift_injected: true,
    drift_detected: true,
    gate_detected: true,
    enforcement_halted: true,
    silent_divergence: false,
    actual_action: "halt",
    audit_decision: null,
    task_success: true,
    hops_run: 0,
  }),
  makeTrial({
    trial_id: "off-b-r0",
    condition: "off",
    scenario_id: "scenario-b",
    drift_injected: false,
    drift_detected: false,
    silent_divergence: false,
    expected_action: "proceed",
    actual_action: "proceed",
    audit_decision: "proceed",
    task_success: true,
  }),
  makeTrial({
    trial_id: "warn-b-r0",
    condition: "warn",
    scenario_id: "scenario-b",
    drift_injected: false,
    drift_detected: false,
    silent_divergence: false,
    expected_action: "proceed",
    actual_action: "proceed",
    audit_decision: "proceed",
    task_success: true,
  }),
  makeTrial({
    trial_id: "enforce-b-r0",
    condition: "enforce",
    scenario_id: "scenario-b",
    drift_injected: false,
    drift_detected: false,
    silent_divergence: false,
    expected_action: "proceed",
    actual_action: "proceed",
    audit_decision: "proceed",
    task_success: true,
  }),
];

let bundleRoot: string | undefined;

async function writeBundle(
  summaryOverride?: Record<string, unknown>,
): Promise<string> {
  bundleRoot = await mkdtemp(join(tmpdir(), "hook-relay-bundle-"));
  const runDir = join(bundleRoot, RUN_ID);
  await mkdir(runDir, { recursive: true });
  const summary = summaryOverride ?? aggregateFromTrials(SYNTHETIC_TRIALS);
  await writeFile(
    join(runDir, "manifest.json"),
    `${JSON.stringify(makeManifest())}\n`,
  );
  await writeFile(join(runDir, "summary.json"), `${JSON.stringify(summary)}\n`);
  await writeFile(
    join(runDir, "trials.public.jsonl"),
    `${SYNTHETIC_TRIALS.map((trial) => JSON.stringify(trial)).join("\n")}\n`,
  );
  return bundleRoot;
}

afterEach(async () => {
  if (bundleRoot !== undefined) {
    await rm(bundleRoot, { recursive: true, force: true });
    bundleRoot = undefined;
  }
});

describe("hook-relay adapter", () => {
  it("registers the hook-enforcement experiment id", () => {
    expect(registeredExperimentIds()).toContain("hook-enforcement");
  });

  it("parseManifest rejects a wrong experimentId and a non-exploratory mode", () => {
    expect(() =>
      hookEnforcementAdapter.parseManifest(
        makeManifest({ experimentId: "babel-hook" }),
      ),
    ).toThrow(/does not match adapter "hook-enforcement"/);

    expect(() =>
      hookEnforcementAdapter.parseManifest(
        makeManifest({ mode: "confirmatory" }),
      ),
    ).toThrow();
  });

  it("redactTrials drops an unknown extra field and preserves all known ones", () => {
    const trial = makeTrial({ secret_payload: "must-not-ship" });
    const output = hookEnforcementAdapter.redactTrials(
      `${JSON.stringify(trial)}\n`,
    );
    expect(output).not.toContain("secret_payload");
    expect(output).not.toContain("must-not-ship");
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    expect(parsed.trial_id).toBe("off-scenario-r0");
    expect(parsed.condition).toBe("off");
    expect(parsed.drift_injected).toBe(true);
    expect(parsed.silent_divergence).toBe(true);
    expect(parsed.hops_run).toBe(3);
  });

  it("loadExperiment renders runs and an experiment body containing the runId", async () => {
    const experimentDir = await writeBundle();
    const loaded = await hookEnforcementAdapter.loadExperiment(experimentDir, [
      RUN_ID,
    ]);
    expect(loaded.experimentId).toBe("hook-enforcement");
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.runs[0]?.runId).toBe(RUN_ID);
    expect(loaded.runs[0]?.runBody).toContain(RUN_ID);
    expect(loaded.runs[0]?.runBody).toContain("Hook Enforcement");
    expect(loaded.experimentBody).toContain(RUN_ID);
    expect(loaded.experimentBody).toContain(
      "Exploratory pilots. Not preregistered, not confirmatory evidence.",
    );
    expect(loaded.experimentBody).toContain(
      "<code>experiments/babel-hook/</code>",
    );
    expect(loaded.overviewCard).toContain("hook-enforcement");
  });

  it("loadExperiment includes a cross-harness comparison table derived from fixture aggregates", async () => {
    const summary = aggregateFromTrials(SYNTHETIC_TRIALS) as {
      conditions: Record<string, Record<string, number>>;
    };
    const enforce = summary.conditions.enforce;
    expect(enforce?.drift_trials).toBe(2);
    expect(enforce?.drift_halted).toBe(2);
    const expectedEnforceCell = `${enforce?.drift_halted}/${enforce?.drift_trials}`;

    const experimentDir = await writeBundle();
    const loaded = await hookEnforcementAdapter.loadExperiment(experimentDir, [
      RUN_ID,
    ]);
    expect(loaded.experimentBody).toContain("Enforce: drift halted");
    expect(loaded.experimentBody).toContain(expectedEnforceCell);
  });

  it("throws when a summary number disagrees with recomputed aggregates", async () => {
    const faithful = aggregateFromTrials(SYNTHETIC_TRIALS);
    const corrupt = structuredClone(faithful) as {
      conditions: Record<string, Record<string, number>>;
    };
    corrupt.conditions.enforce = {
      ...corrupt.conditions.enforce,
      detection: 99,
    };
    const experimentDir = await writeBundle(corrupt);
    await expect(
      hookEnforcementAdapter.loadExperiment(experimentDir, [RUN_ID]),
    ).rejects.toThrow(/enforce\.detection: summary=99, recomputed=2/);
  });
});
