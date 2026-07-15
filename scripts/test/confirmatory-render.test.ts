// -------------------------------------------------------------------------
// Confirmatory rendering tests
//
// The site must render a confirmatory run's preregistered-hypotheses panel and
// the cross-arm verdict WITHOUT reimplementing any statistics: every number is
// recomputed by the registered analysis module. These tests use that module
// (analyzeArm / analyzeReport) as the ORACLE — the rendered HTML must carry
// exactly the PASS/FAIL, intervals, and verdict the module computes.
//
// They also lock the "plain failure" contract: the panel and verdict must render
// with the same structure whether the outcome is confirmed, partial, or refuted
// — only the PASS/FAIL/verdict word (and its status-token colour) differs.
// -------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import type {
  ExperimentCondition,
  ResultManifest,
} from "../../packages/core/src/schemas.js";
import {
  analyzeArm,
  analyzeReport,
  type ArmInput,
} from "../../experiments/babel-relay/src/confirmatory-analysis.js";
import { aggregateTrials } from "../lib/aggregate.js";
import {
  confirmatoryAnalysisFor,
  confirmatoryStatusLabel,
  escapeHtml,
  provenanceList,
  renderBabelRelayCard,
  renderConfirmatoryVerdict,
  renderHypothesisPanel,
  renderRunPage,
  selectConfirmatoryRunPerModel,
  type RunView,
} from "../lib/render.js";
import { makeTrial } from "./fixtures.js";

const HEX64 = "a".repeat(64);
const PREREG_PATH =
  "docs/preregistrations/prereg-001-babel-relay-confirmatory.md";
const PREREG_DIGEST =
  "40be2c73dbec9beb8f46ab27d6b56c53c94c4372cca2d1647e235e6085fb46b7";
const REGISTERED_COMMIT = "e83e10377d74620f854627d641e047537110a992";

const NEMO = "unsloth/Mistral-Nemo-Instruct-2407-TEE";
const MINIMAX = "MiniMaxAI/MiniMax-M2.5-TEE";
const QWEN = "Qwen/Qwen3-32B-TEE";

interface ConditionSpec {
  condition: ExperimentCondition;
  driftTrials: number;
  silentDivergences: number;
  controlTrials: number;
  taskSuccesses: number;
}

function buildCondition(spec: ConditionSpec) {
  const records = [];
  const total = spec.driftTrials + spec.controlTrials;
  for (let i = 0; i < total; i += 1) {
    const isDrift = i < spec.driftTrials;
    records.push(
      makeTrial({
        scenarioId: "s1",
        condition: spec.condition,
        seed: i,
        metrics: {
          driftInjected: isDrift,
          driftDetected: isDrift && !(i < spec.silentDivergences),
          silentDivergence: isDrift && i < spec.silentDivergences,
          taskSuccess: i < spec.taskSuccesses,
        },
      }),
    );
  }
  return records;
}

/** A clean, fully-confirming arm shaped like the pilot decomposition. */
function confirmingRecords() {
  return [
    ...buildCondition({
      condition: "baseline",
      driftTrials: 120,
      silentDivergences: 115,
      controlTrials: 60,
      taskSuccesses: 60,
    }),
    ...buildCondition({
      condition: "equal-prose",
      driftTrials: 120,
      silentDivergences: 110,
      controlTrials: 60,
      taskSuccesses: 70,
    }),
    ...buildCondition({
      condition: "opaque-resolver",
      driftTrials: 120,
      silentDivergences: 108,
      controlTrials: 60,
      taskSuccesses: 72,
    }),
    ...buildCondition({
      condition: "addressed-voluntary",
      driftTrials: 120,
      silentDivergences: 0,
      controlTrials: 60,
      taskSuccesses: 60,
    }),
    ...buildCondition({
      condition: "addressed-enforced",
      driftTrials: 120,
      silentDivergences: 0,
      controlTrials: 60,
      taskSuccesses: 170,
    }),
  ];
}

/** An arm that fails H3 (baseline floor far below 50%): a refuting arm. */
function h3FailingRecords() {
  return [
    ...buildCondition({
      condition: "baseline",
      driftTrials: 120,
      silentDivergences: 30, // 25% — H3 Wilson lower well below 50%.
      controlTrials: 60,
      taskSuccesses: 60,
    }),
    ...confirmingRecords().filter((r) => r.condition !== "baseline"),
  ];
}

function makeManifest(overrides: Partial<ResultManifest> = {}): ResultManifest {
  const provenance = {
    artifactSchemaVersion: "0.3.0",
    protocolVersion: "0.3.0",
    fixtureDigest: HEX64,
    implementationCommit: REGISTERED_COMMIT,
    dependencyLockDigest: HEX64,
    promptDigest: HEX64,
    semaVersion: "0.3.0",
    canonicalizationVersion: "v2",
    vocabularyRoot: "root",
    semanticBackend: "fixture",
    modelProvider: "llm.chutes.ai",
    modelName: NEMO,
    preregistrationPath: PREREG_PATH,
    preregistrationDigest: PREREG_DIGEST,
    ...(overrides.provenance ?? {}),
  };
  return {
    artifactSchemaVersion: "0.3.0",
    protocolVersion: "0.3.0",
    experimentId: "babel-relay",
    runId: "20260716T000000000Z-order-20260716",
    mode: "confirmatory",
    evidenceClaim:
      "Preregistered confirmatory experiment. Hypotheses, sample size, exclusions, and analysis were fixed at registration; see the preregistration digest in provenance.",
    createdAt: "2026-07-16T00:00:00.000Z",
    orderSeed: 20260716,
    seeds: [0],
    conditions: [
      "baseline",
      "equal-prose",
      "opaque-resolver",
      "addressed-voluntary",
      "addressed-enforced",
    ],
    scenarioCount: 1,
    trialCount: 900,
    fixtureDigest: HEX64,
    ...overrides,
    provenance,
  };
}

function runView(
  records: ReturnType<typeof confirmingRecords>,
  overrides: Partial<ResultManifest> = {},
): RunView {
  const manifest = makeManifest(overrides);
  return {
    manifest,
    aggregate: aggregateTrials(records),
    dataDir: manifest.runId,
    records,
  };
}

describe("renderHypothesisPanel — oracle match", () => {
  it("renders one row per registered hypothesis with the module's PASS/FAIL and intervals", () => {
    const records = confirmingRecords();
    const analysis = analyzeArm({
      arm: NEMO,
      mode: "confirmatory",
      trials: records,
    });
    const html = renderHypothesisPanel(analysis);

    expect(html).toContain("Preregistered hypotheses");
    // H1 (both arms), H2, H3 rows present.
    expect(html).toContain("<code>H1</code>");
    expect(html).toContain("<code>H2</code>");
    expect(html).toContain("<code>H3</code>");
    expect(html).toContain("<code>addressed-voluntary</code>");
    expect(html).toContain("<code>addressed-enforced</code>");
    // Every recomputed hypothesis passes here → four PASS, no FAIL.
    for (const check of analysis.hypotheses) {
      expect(check.pass).toBe(true);
    }
    expect(html).toContain('<span class="pf pf-pass">PASS</span>');
    expect(html).not.toContain('pf-fail">FAIL');
    // The exact registered interval bounds appear verbatim (recomputed, not stored).
    const h3 = analysis.hypotheses.find((c) => c.id === "H3")!;
    expect(html).toContain(`${(h3.interval.lower * 100).toFixed(1)}%`);
    // Methods are named.
    expect(html).toContain("Clopper–Pearson");
    expect(html).toContain("Newcombe");
    expect(html).toContain("Wilson");
    // Exclusion accounting line: 0 exclusions, 2% threshold, arm valid.
    expect(html).toContain("Excluded trials (hop failures):");
    expect(html).toContain("2.0%");
    expect(html).toContain("arm valid");
  });

  it("renders a failing hypothesis as plainly as a passing one (only PASS/FAIL differs)", () => {
    const analysis = analyzeArm({
      arm: NEMO,
      mode: "confirmatory",
      trials: h3FailingRecords(),
    });
    const h3 = analysis.hypotheses.find((c) => c.id === "H3")!;
    expect(h3.pass).toBe(false);
    const html = renderHypothesisPanel(analysis);
    expect(html).toContain('<span class="pf pf-fail">FAIL</span>');
    // No celebratory / alarming structure: the same wrapper + table as a pass.
    expect(html).toContain('<div class="hypotheses">');
    expect(html).toContain("<h2>Preregistered hypotheses</h2>");
  });

  it("is byte-identical across repeated renders", () => {
    const analysis = analyzeArm({
      arm: NEMO,
      mode: "confirmatory",
      trials: confirmingRecords(),
    });
    expect(renderHypothesisPanel(analysis)).toEqual(
      renderHypothesisPanel(analysis),
    );
  });
});

describe("run page — confirmatory panel + provenance", () => {
  it("places the hypotheses panel above the results table and links the prereg", () => {
    const html = renderRunPage(runView(confirmingRecords()));
    expect(html).toContain("Preregistered hypotheses");
    expect(html.indexOf("Preregistered hypotheses")).toBeLessThan(
      html.indexOf("Results by condition"),
    );
    // Confirmatory badge + evidence claim banner.
    expect(html).toContain('class="badge badge-confirmatory"');
    expect(html).toContain("Preregistered confirmatory experiment.");
    // Provenance gains the prereg digest + a blob link at the registered commit.
    expect(html).toContain("Preregistration digest");
    expect(html).toContain(PREREG_DIGEST);
    expect(html).toContain(
      `href="https://github.com/RobinOppenstam/sema-evals/blob/${REGISTERED_COMMIT}/${PREREG_PATH}"`,
    );
  });

  it("renders no hypotheses panel for a non-confirmatory run", () => {
    const view: RunView = {
      manifest: makeManifest({ mode: "model-pilot" }),
      aggregate: aggregateTrials(confirmingRecords()),
      dataDir: "run",
    };
    expect(confirmatoryAnalysisFor(view)).toBeUndefined();
    expect(renderRunPage(view)).not.toContain("Preregistered hypotheses");
  });
});

describe("renderConfirmatoryVerdict — cross-arm", () => {
  function armInput(model: string, records: ArmInput["trials"]): ArmInput {
    return { arm: model, mode: "confirmatory", trials: records };
  }

  it("reports 'verdict pending' with the arm count when arms are missing", () => {
    const runs = [
      runView(confirmingRecords(), {
        runId: "run-nemo",
        provenance: { ...makeManifest().provenance, modelName: NEMO },
      }),
    ];
    const html = renderConfirmatoryVerdict(runs);
    expect(html).toContain("verdict pending");
    expect(html).toContain("1 of 3 registered arms published");
    // Matrix lists every registered arm; the two missing ones are pending.
    expect(html).toContain("<code>Mistral-Nemo-Instruct-2407-TEE</code>");
    expect(html).toContain("<code>MiniMax-M2.5-TEE</code>");
    expect(html).toContain("<code>Qwen3-32B-TEE</code>");
    expect(html).toContain('<span class="pf pf-pending">pending</span>');
    // The published arm passes all three H groups.
    expect(html).toContain('<span class="pf pf-pass">PASS</span>');
    expect(confirmatoryStatusLabel(runs)).toBe("pending (1 of 3 arms)");
  });

  it("matches analyzeReport for a partial verdict once all arms are published", () => {
    const runs = [
      runView(confirmingRecords(), {
        runId: "run-nemo",
        provenance: { ...makeManifest().provenance, modelName: NEMO },
      }),
      runView(confirmingRecords(), {
        runId: "run-minimax",
        provenance: { ...makeManifest().provenance, modelName: MINIMAX },
      }),
      // Qwen fails H3 → the conjunctive verdict is partial.
      runView(h3FailingRecords(), {
        runId: "run-qwen",
        provenance: { ...makeManifest().provenance, modelName: QWEN },
      }),
    ];
    // Oracle: the registered module's verdict over the same three arms.
    const oracle = analyzeReport(
      ["run-minimax", "run-nemo", "run-qwen"],
      [
        armInput(MINIMAX, confirmingRecords()),
        armInput(NEMO, confirmingRecords()),
        armInput(QWEN, h3FailingRecords()),
      ],
    );
    expect(oracle.verdict).toBe("partial");

    const html = renderConfirmatoryVerdict(runs);
    expect(html).toContain('<span class="pf pf-partial">partial</span>');
    // The verdict detail is the module's, HTML-escaped verbatim (it contains ">").
    expect(html).toContain(escapeHtml(oracle.verdictDetail));
    // Qwen's H3 renders FAIL; Nemo/MiniMax pass.
    expect(html).toContain('<span class="pf pf-fail">FAIL</span>');
    expect(html).toContain('<span class="pf pf-pass">PASS</span>');
    expect(confirmatoryStatusLabel(runs)).toBe("partial");
  });

  it("reports 'confirmed' only when every registered arm confirms", () => {
    const runs = [NEMO, MINIMAX, QWEN].map((model, i) =>
      runView(confirmingRecords(), {
        runId: `run-${i}`,
        provenance: { ...makeManifest().provenance, modelName: model },
      }),
    );
    const html = renderConfirmatoryVerdict(runs);
    expect(html).toContain('<span class="pf pf-pass">confirmed</span>');
    expect(confirmatoryStatusLabel(runs)).toBe("confirmed");
  });

  it("renders nothing when there is no confirmatory run", () => {
    const view: RunView = {
      manifest: makeManifest({ mode: "model-pilot" }),
      aggregate: aggregateTrials(confirmingRecords()),
      dataDir: "run",
    };
    expect(renderConfirmatoryVerdict([view])).toBe("");
    expect(confirmatoryStatusLabel([view])).toBeUndefined();
  });

  it("is byte-identical across repeated renders", () => {
    const runs = [
      runView(confirmingRecords(), {
        runId: "run-nemo",
        provenance: { ...makeManifest().provenance, modelName: NEMO },
      }),
    ];
    expect(renderConfirmatoryVerdict(runs)).toEqual(
      renderConfirmatoryVerdict(runs),
    );
  });
});

describe("selectConfirmatoryRunPerModel", () => {
  it("keeps the latest confirmatory run per model and ignores other modes", () => {
    const runs: RunView[] = [
      runView(confirmingRecords(), {
        runId: "nemo-early",
        createdAt: "2026-07-16T01:00:00.000Z",
        provenance: { ...makeManifest().provenance, modelName: NEMO },
      }),
      runView(confirmingRecords(), {
        runId: "nemo-late",
        createdAt: "2026-07-16T05:00:00.000Z",
        provenance: { ...makeManifest().provenance, modelName: NEMO },
      }),
      {
        manifest: makeManifest({ mode: "model-pilot", runId: "pilot" }),
        aggregate: aggregateTrials(confirmingRecords()),
        dataDir: "pilot",
      },
    ];
    const selected = selectConfirmatoryRunPerModel(runs);
    expect(selected.map((r) => r.manifest.runId)).toEqual(["nemo-late"]);
  });
});

describe("overview card", () => {
  it("adds the confirmatory status once a confirmatory run is present", () => {
    const runs = [
      runView(confirmingRecords(), {
        runId: "run-nemo",
        provenance: { ...makeManifest().provenance, modelName: NEMO },
      }),
    ];
    const html = renderBabelRelayCard("babel-relay", runs);
    expect(html).toContain("Confirmatory:");
    expect(html).toContain("pending (1 of 3 arms)");
  });
});

describe("provenanceList — non-confirmatory", () => {
  it("adds no preregistration rows when the manifest carries none", () => {
    const manifest = makeManifest({ mode: "model-pilot" });
    const bare = {
      ...manifest,
      provenance: {
        ...manifest.provenance,
        preregistrationPath: undefined,
        preregistrationDigest: undefined,
      },
    };
    const html = provenanceList(bare);
    expect(html).not.toContain("Preregistration");
  });
});
