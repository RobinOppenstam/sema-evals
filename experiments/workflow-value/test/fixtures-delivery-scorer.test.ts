import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureReferenceProvider } from "@sema-evals/adapters";
import { describe, expect, it } from "vitest";

import { buildConditions } from "../src/conditions.js";
import { buildWorkflowDelivery } from "../src/delivery.js";
import {
  assertDatasetReadyForModelPilot,
  evaluateDatasetAcquisitionGate,
  loadFixtureFile,
} from "../src/fixtures.js";
import { createWorkflowModelProvider } from "../src/provider.js";
import { parseWorkflowOutput, validateWorkflowOutput } from "../src/scorer.js";
import { workflowFixtureSetSchema } from "../src/schemas.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/seed-tasks.yaml",
);

describe("workflow seed fixtures and acquisition gate", () => {
  it("loads clearly labelled non-empty dev/eval seed splits", async () => {
    const loaded = await loadFixtureFile(FIXTURE_PATH);
    expect(loaded.fixtureSet.dataset).toMatchObject({
      label: "synthetic-seed-fixtures",
      status: "seed-only",
    });
    expect(loaded.devTaskCount).toBeGreaterThan(0);
    expect(loaded.evalTaskCount).toBeGreaterThan(0);
    expect(
      loaded.fixtureSet.tasks.every((task) =>
        task.id.startsWith(`seed-${task.split}-`),
      ),
    ).toBe(true);
  });

  it("blocks shared provider construction while fixtures remain seed-only", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    expect(evaluateDatasetAcquisitionGate(fixtureSet).readyForModelPilot).toBe(
      false,
    );
    expect(() => assertDatasetReadyForModelPilot(fixtureSet)).toThrow(
      /model pilot blocked/i,
    );
    expect(() =>
      createWorkflowModelProvider({
        fixtureSet,
        provider: "grok-build",
        systemPrompt: "frozen",
        model: "grok-4.5",
        maxTokens: 2048,
        thinking: "none",
      }),
    ).toThrow(/seed-only/i);
  });

  it("requires complete acquisition evidence rather than a status flip", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    expect(() =>
      workflowFixtureSetSchema.parse({
        ...fixtureSet,
        dataset: { ...fixtureSet.dataset, status: "acquired" },
      }),
    ).toThrow();
    const acquired = workflowFixtureSetSchema.parse({
      ...fixtureSet,
      dataset: {
        label: "licensed-workflow-corpus-v1",
        status: "acquired",
        source: "frozen external corpus",
        acquisitionRequirement: "complete",
        license: "Apache-2.0",
        acquiredAt: "2026-07-16T00:00:00.000Z",
        corpusDigest: "d".repeat(64),
        taskFamilySplitMethod: "family-level heldout split",
        deduplicationReport: "exact and near-duplicate review passed",
        leakageReview: "task-answer leakage review passed",
        validatorReview: "two-reviewer validator audit passed",
      },
      tasks: fixtureSet.tasks.map((task, index) => ({
        ...task,
        id: `workflow-task-${index}`,
      })),
    });
    expect(evaluateDatasetAcquisitionGate(acquired).readyForModelPilot).toBe(
      true,
    );
  });
});

describe("condition parity and hidden scorer", () => {
  it("delivers byte-identical workflow content exactly once across guided arms", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const task = fixtureSet.tasks[0]!;
    const provider = new FixtureReferenceProvider();
    const deliveries = await Promise.all(
      buildConditions().map((condition) =>
        buildWorkflowDelivery(task, condition, provider),
      ),
    );
    const byCondition = new Map(
      buildConditions().map((condition, index) => [
        condition,
        deliveries[index]!,
      ]),
    );
    expect(
      JSON.parse(byCondition.get("task-only")!.userMessage).resolvedWorkflow,
    ).toBeUndefined();

    const guided = [
      "equal-prose",
      "opaque-resolver",
      "content-addressed",
      "content-addressed-repair",
    ] as const;
    const library = guided.map(
      (condition) =>
        JSON.parse(byCondition.get(condition)!.userMessage).resolvedWorkflow,
    );
    expect(
      library.every(
        (value) => JSON.stringify(value) === JSON.stringify(library[0]),
      ),
    ).toBe(true);
    expect(byCondition.get("equal-prose")!.hydrationBytes).toBe(0);
    expect(byCondition.get("opaque-resolver")!.hydrationBytes).toBeGreaterThan(
      0,
    );
    expect(
      byCondition.get("content-addressed")!.workflowReference,
    ).not.toBeNull();
    expect(
      byCondition.get("content-addressed-repair")!.mismatchNotice,
    ).not.toBeNull();
  });

  it("keeps executable validator expectations scorer-side", async () => {
    const { fixtureSet } = await loadFixtureFile(FIXTURE_PATH);
    const task = fixtureSet.tasks[1]!;
    const parsed = parseWorkflowOutput(
      `\`\`\`json\n${JSON.stringify(task.workflow.output)}\n\`\`\``,
    );
    expect(parsed.parseable).toBe(true);
    expect(validateWorkflowOutput(task, parsed.output).validationPassed).toBe(
      true,
    );
    expect(validateWorkflowOutput(task, task.localDraft).validationPassed).toBe(
      false,
    );
    const delivery = await buildWorkflowDelivery(
      task,
      "equal-prose",
      new FixtureReferenceProvider(),
    );
    expect(delivery.userMessage).not.toContain('"validator"');
  });
});
