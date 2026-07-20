// -------------------------------------------------------------------------
// Experiment site-adapter registry
//
// Each experiment id maps to a self-contained adapter that owns its record and
// manifest parse gates, its recompute-and-cross-check discipline, and its run-
// page and index-section renderers. Both the site builder and the promote
// script dispatch through this registry, so adding an experiment is a single
// registration here.
// -------------------------------------------------------------------------

import type { ExperimentAdapter } from "./adapter-support.js";
import { babelRelayAdapter } from "./adapters/babel-relay.js";
import {
  babelHookAdapter,
  codexHookAdapter,
  cursorHookAdapter,
} from "./adapters/hook-relay.js";
import { semaTaxAdapter } from "./adapters/sema-tax.js";

export type {
  ExperimentAdapter,
  LoadedExperiment,
  PromoteManifest,
  RunFile,
} from "./adapter-support.js";

const ADAPTERS: Readonly<Record<string, ExperimentAdapter>> = {
  [babelRelayAdapter.experimentId]: babelRelayAdapter,
  [babelHookAdapter.experimentId]: babelHookAdapter,
  [codexHookAdapter.experimentId]: codexHookAdapter,
  [cursorHookAdapter.experimentId]: cursorHookAdapter,
  [semaTaxAdapter.experimentId]: semaTaxAdapter,
};

/** The registered adapter for an experiment id, or `undefined` if none. */
export function getAdapter(
  experimentId: string,
): ExperimentAdapter | undefined {
  return ADAPTERS[experimentId];
}

/** The registered adapter for an experiment id, throwing if none is registered. */
export function requireAdapter(experimentId: string): ExperimentAdapter {
  const adapter = ADAPTERS[experimentId];
  if (adapter === undefined) {
    throw new Error(
      `No site adapter registered for experiment "${experimentId}". ` +
        `Register one in scripts/lib/experiment-adapter.ts.`,
    );
  }
  return adapter;
}

/** All registered experiment ids, sorted. */
export function registeredExperimentIds(): string[] {
  return Object.keys(ADAPTERS).sort();
}
