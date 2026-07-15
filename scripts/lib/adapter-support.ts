// Shared helpers for experiment site adapters. Kept in its own module (importing
// no adapter) so adapters can depend on it without a circular import.

/**
 * Fail the build if a recomputed aggregate disagrees with a bundle's committed
 * `summary.json`. The site never trusts a stored summary — every experiment
 * recomputes from the public trial derivative and cross-checks. A disagreement
 * means the published trials and the published summary describe different data,
 * which must never ship, so this throws rather than warns.
 */
export function assertSummaryFaithful(
  experimentId: string,
  runId: string,
  warnings: readonly string[],
): void {
  if (warnings.length === 0) {
    return;
  }
  const detail = warnings.map((warning) => `  - ${warning}`).join("\n");
  throw new Error(
    `[build-site] ${experimentId}/${runId}: summary.json disagrees with recomputed ` +
      `aggregates from trials.public.jsonl:\n${detail}`,
  );
}

/** A rendered run page plus the metadata build-site needs to write its files. */
export interface RunFile {
  runId: string;
  createdAt: string;
  /** Rendered run-page body (from `page()`); build-site wraps it in `<head>`. */
  runPage: string;
}

/** Everything an adapter produces for one experiment's promoted runs. */
export interface LoadedExperiment {
  experimentId: string;
  runs: RunFile[];
  /** The index section: `<h2>` heading through the run-list table and note. */
  indexSection: string;
}

/** Minimal manifest shape the promote path needs, common to every experiment. */
export interface PromoteManifest {
  experimentId: string;
  runId: string;
  mode: string;
  createdAt: string;
  evidenceClaim: string;
}

/** The per-experiment site adapter contract dispatched by experiment id. */
export interface ExperimentAdapter {
  readonly experimentId: string;
  /** Validate a raw manifest object before promotion (throws on invalid). */
  parseManifest(raw: unknown): PromoteManifest;
  /** Parse and redact a raw `trials.jsonl` into public-derivative JSONL text. */
  redactTrials(source: string): string;
  /** Load, validate, recompute, cross-check, and render an experiment's runs. */
  loadExperiment(
    experimentDir: string,
    runIds: readonly string[],
  ): Promise<LoadedExperiment>;
}
