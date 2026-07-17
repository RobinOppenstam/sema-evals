import type { SemanticReferenceProvider } from "@sema-evals/adapters";
import {
  utf8Bytes,
  type MatrixCell,
  type TrialEvent,
  type TrialProvenance,
} from "@sema-evals/core";

import { conditionPolicy } from "./conditions.js";
import {
  resolveDependencyClosure,
  type DependencyResolution,
} from "./dependencies.js";
import { rankPatterns } from "./search.js";
import {
  semaDiscoveryTrialRecordSchema,
  type DiscoveryPattern,
  type DiscoveryScenario,
  type DiscoveryTaskResult,
  type SemaDiscoveryCondition,
  type SemaDiscoveryTrialRecord,
} from "./schemas.js";

export interface SemaDiscoveryTrialOptions {
  catalog: readonly DiscoveryPattern[];
  referenceProvider: SemanticReferenceProvider;
  provenance: TrialProvenance;
}

interface PreparedSession {
  selectedHandle: string;
  resolution: DependencyResolution;
}

function patternDefinition(pattern: DiscoveryPattern): Record<string, unknown> {
  return {
    handle: pattern.handle,
    title: pattern.title,
    purpose: pattern.purpose,
    tags: [...pattern.tags],
    dependencies: [...pattern.dependencies],
    steps: [...pattern.steps],
  };
}

function requiredDependencyCount(
  correctHandle: string,
  catalog: readonly DiscoveryPattern[],
): number {
  const resolution = resolveDependencyClosure(correctHandle, catalog);
  return resolution.status === "complete"
    ? Math.max(0, resolution.orderedPatterns.length - 1)
    : 0;
}

export async function runSemaDiscoveryTrial(
  cell: MatrixCell<DiscoveryScenario, SemaDiscoveryCondition>,
  options: SemaDiscoveryTrialOptions,
): Promise<SemaDiscoveryTrialRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const policy = conditionPolicy(cell.condition);
  const events: TrialEvent[] = [];
  let sequence = 0;
  let session: PreparedSession | null = null;
  let wireBytes = 0;
  let hydrationBytes = 0;
  let searchesPerformed = 0;
  let candidatesReturned = 0;
  let distractorsConsidered = 0;
  let selectionsPerformed = 0;
  let correctSelections = 0;
  let resolvedDependencyCount = 0;
  let missingDependencyCount = 0;
  let reuseHits = 0;
  let searchesAvoided = 0;
  let dependencyResolutionsAvoided = 0;

  events.push({
    sequence: sequence++,
    type: "verification",
    boundary: null,
    agent: "discovery-session",
    details: { action: "reset", cacheEntries: 0 },
  });

  const taskResults: DiscoveryTaskResult[] = [];
  for (const [taskIndex, task] of cell.scenario.tasks.entries()) {
    const taskWireBytes = utf8Bytes({ task: task.request });
    wireBytes += taskWireBytes;
    let searchPerformed = false;
    let candidates: ReturnType<typeof rankPatterns> = [];
    let selectedHandle: string | null = null;
    let selectedRank: number | null = null;
    let correctSelection = false;
    let resolution: DependencyResolution = {
      status: "missing",
      orderedPatterns: [],
      missingHandles: [],
    };
    let reuseHit = false;

    if (!policy.receivesPatterns) {
      resolution = {
        status: "missing",
        orderedPatterns: [],
        missingHandles: [cell.scenario.correctHandle],
      };
    } else if (
      policy.reusesWithinSession &&
      taskIndex > 0 &&
      session !== null
    ) {
      selectedHandle = session.selectedHandle;
      correctSelection = selectedHandle === cell.scenario.correctHandle;
      resolution = session.resolution;
      reuseHit = true;
      reuseHits += 1;
      searchesAvoided += 1;
      dependencyResolutionsAvoided += 1;
      wireBytes += utf8Bytes({ reuseHandle: selectedHandle });
      events.push({
        sequence: sequence++,
        type: "message",
        boundary: null,
        agent: "discovery-session",
        details: {
          taskId: task.id,
          action: "reuse",
          selectedHandle,
          closure: resolution.orderedPatterns.map((pattern) => pattern.handle),
        },
      });
    } else {
      if (policy.performsDiscovery) {
        searchPerformed = true;
        searchesPerformed += 1;
        candidates = rankPatterns(task.request, options.catalog);
        candidatesReturned += candidates.length;
        distractorsConsidered += candidates.filter(
          (candidate) => candidate.handle !== cell.scenario.correctHandle,
        ).length;
        selectedHandle = candidates[0]?.handle ?? null;
        selectedRank =
          selectedHandle === null
            ? null
            : candidates.findIndex(
                (candidate) => candidate.handle === selectedHandle,
              ) + 1;
        selectionsPerformed += selectedHandle === null ? 0 : 1;
        wireBytes += utf8Bytes({
          query: task.request,
          candidates,
        });
        events.push({
          sequence: sequence++,
          type: "message",
          boundary: null,
          agent: "sema-search",
          details: {
            taskId: task.id,
            candidates,
            selectedHandle,
            selectedRank,
          },
        });
      } else {
        selectedHandle = cell.scenario.correctHandle;
      }

      correctSelection = selectedHandle === cell.scenario.correctHandle;
      if (policy.performsDiscovery && correctSelection) {
        correctSelections += 1;
      }
      resolution =
        selectedHandle === null
          ? {
              status: "missing",
              orderedPatterns: [],
              missingHandles: [cell.scenario.correctHandle],
            }
          : resolveDependencyClosure(selectedHandle, options.catalog);

      if (
        policy.reusesWithinSession &&
        taskIndex === 0 &&
        selectedHandle !== null &&
        resolution.status === "complete"
      ) {
        session = { selectedHandle, resolution };
      }
    }

    if (resolution.status === "complete") {
      resolvedDependencyCount += Math.max(
        0,
        resolution.orderedPatterns.length - 1,
      );
    } else {
      missingDependencyCount += Math.max(1, resolution.missingHandles.length);
    }

    if (policy.receivesPatterns && !reuseHit) {
      if (policy.addressed) {
        const references = await Promise.all(
          resolution.orderedPatterns.map(async (pattern) => {
            const reference = await options.referenceProvider.reference(
              pattern.handle,
              patternDefinition(pattern),
            );
            hydrationBytes += utf8Bytes(patternDefinition(pattern));
            return reference.full;
          }),
        );
        wireBytes += utf8Bytes({ requiredSemanticRefs: references });
      } else {
        wireBytes += utf8Bytes({
          patterns: resolution.orderedPatterns.map(patternDefinition),
        });
      }
    }

    const root = resolution.orderedPatterns.find(
      (pattern) => pattern.handle === selectedHandle,
    );
    const executionPassed =
      correctSelection &&
      resolution.status === "complete" &&
      root !== undefined &&
      JSON.stringify(root.steps) === JSON.stringify(task.expectedActions);
    const outputActions = executionPassed ? [...root.steps] : [];

    events.push({
      sequence: sequence++,
      type: "completion",
      boundary: null,
      agent: "scripted-pattern-executor",
      details: {
        taskId: task.id,
        selectedHandle,
        dependencyStatus: resolution.status,
        executionPassed,
        reuseHit,
      },
    });
    taskResults.push({
      taskId: task.id,
      searchPerformed,
      candidates,
      selectedHandle,
      selectedRank,
      correctSelection,
      dependencyStatus: policy.receivesPatterns
        ? resolution.status
        : "not-provided",
      resolvedHandles: resolution.orderedPatterns.map(
        (pattern) => pattern.handle,
      ),
      missingHandles: resolution.missingHandles,
      executionPassed,
      reuseHit,
      outputActions,
    });
  }

  session = null;
  events.push({
    sequence: sequence++,
    type: "verification",
    boundary: null,
    agent: "discovery-session",
    details: { action: "clear", cacheEntries: 0 },
  });

  const requiredDependencies =
    requiredDependencyCount(cell.scenario.correctHandle, options.catalog) *
    cell.scenario.tasks.length;
  const dependencyComplete = taskResults.every(
    (result) => result.dependencyStatus === "complete",
  );
  const executionsPassed = taskResults.filter(
    (result) => result.executionPassed,
  ).length;
  const endToEndDiscoverySuccess =
    policy.performsDiscovery &&
    taskResults.every(
      (result) =>
        result.correctSelection &&
        result.dependencyStatus === "complete" &&
        result.executionPassed,
    );

  return semaDiscoveryTrialRecordSchema.parse({
    trialId: cell.trialId,
    experimentId: "sema-discovery",
    scenarioId: cell.scenarioId,
    condition: cell.condition,
    seed: cell.seed,
    executionIndex: cell.executionIndex,
    startedAt,
    completedAt: new Date().toISOString(),
    taskResults,
    events,
    metrics: {
      sessionResetAtStart: true,
      sessionClearedAtEnd: session === null,
      searchesPerformed,
      candidatesReturned,
      distractorsConsidered,
      selectionsPerformed,
      correctSelections,
      requiredDependencyCount: requiredDependencies,
      resolvedDependencyCount,
      missingDependencyCount,
      dependencyComplete,
      executionsPassed,
      reuseHits,
      searchesAvoided,
      dependencyResolutionsAvoided,
      endToEndDiscoverySuccess,
      wireBytes,
      hydrationBytes,
      totalSemanticBytes: wireBytes + hydrationBytes,
      elapsedMs: performance.now() - started,
    },
    provenance: options.provenance,
    usage: null,
    transcript: null,
  });
}
