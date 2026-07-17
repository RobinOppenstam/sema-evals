import { fingerprint } from "./fingerprint.js";

export interface MatrixCell<Scenario, Condition> {
  scenario: Scenario;
  scenarioId: string;
  condition: Condition;
  seed: number;
  executionIndex: number;
  trialId: string;
}

export interface MatrixPlanOptions<Scenario, Condition> {
  experimentId: string;
  protocolVersion: string;
  scenarios: readonly Scenario[];
  scenarioId: (scenario: Scenario) => string;
  conditions: readonly Condition[];
  seeds: readonly number[];
  orderSeed: number;
}

function numericSeed(value: string): number {
  return Number.parseInt(fingerprint(value).slice(0, 8), 16) >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const output = [...values];
  const random = mulberry32(seed);

  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const current = output[index];
    const replacement = output[target];
    if (current === undefined || replacement === undefined) {
      throw new Error("Matrix shuffle encountered an invalid index.");
    }
    output[index] = replacement;
    output[target] = current;
  }

  return output;
}

export function planPairedMatrix<Scenario, Condition>(
  options: MatrixPlanOptions<Scenario, Condition>,
): MatrixCell<Scenario, Condition>[] {
  const blocks = options.scenarios.flatMap((scenario) =>
    options.seeds.map((seed) => ({
      scenario,
      scenarioId: options.scenarioId(scenario),
      seed,
    })),
  );

  const orderedBlocks = shuffled(blocks, options.orderSeed);
  const cells: Array<Omit<MatrixCell<Scenario, Condition>, "executionIndex">> =
    [];

  for (const block of orderedBlocks) {
    const conditionSeed = numericSeed(
      `${options.orderSeed}:${block.scenarioId}:${block.seed}`,
    );
    for (const condition of shuffled(options.conditions, conditionSeed)) {
      cells.push({
        ...block,
        condition,
        trialId: fingerprint({
          experimentId: options.experimentId,
          protocolVersion: options.protocolVersion,
          scenarioId: block.scenarioId,
          condition,
          seed: block.seed,
        }),
      });
    }
  }

  return cells.map((cell, executionIndex) => ({ ...cell, executionIndex }));
}

export interface ExecuteMatrixOptions<Scenario, Condition, Record> {
  /**
   * Maximum number of trials in flight at once. Defaults to `1` (strictly
   * sequential, the historical behavior). Trials are always STARTED in the
   * planned order — the pool always claims the lowest not-yet-started index —
   * so the recorded execution order still follows the order seed even though
   * completion order may differ under concurrency. Values below 1 are clamped
   * to 1 and non-integers are truncated.
   */
  concurrency?: number;
  /**
   * Invoked once per trial as it settles, in COMPLETION order (which may differ
   * from planned order under concurrency). Intended for progress reporting; it
   * must not mutate the returned array, whose ordering is fixed to planned
   * order regardless of when trials complete.
   */
  onComplete?: (
    record: Record,
    cell: MatrixCell<Scenario, Condition>,
  ) => void | Promise<void>;
}

/**
 * Executes planned matrix cells, returning one record per cell.
 *
 * The returned array is ALWAYS in planned order: `records[i]` is the result of
 * `cells[i]`, regardless of the order trials actually complete in. This keeps
 * downstream analysis deterministic and independent of provider timing. With
 * `concurrency > 1` a bounded worker pool keeps at most N trials in flight while
 * still starting them in planned order, so the randomized-order discipline is
 * preserved (start order follows the seed; each record timestamps its own
 * actual execution via `startedAt`/`completedAt`).
 */
export async function executeMatrix<Scenario, Condition, Record>(
  cells: readonly MatrixCell<Scenario, Condition>[],
  execute: (cell: MatrixCell<Scenario, Condition>) => Promise<Record>,
  options: ExecuteMatrixOptions<Scenario, Condition, Record> = {},
): Promise<Record[]> {
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  const records = new Array<Record>(cells.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      // Claiming the index before the first await is atomic on the single JS
      // thread, so each worker takes the lowest not-yet-started cell: trials
      // are started in planned order even though they finish out of order.
      const current = nextIndex;
      if (current >= cells.length) {
        return;
      }
      nextIndex += 1;
      const cell = cells[current];
      if (cell === undefined) {
        throw new Error("Matrix execution encountered an undefined cell.");
      }
      const record = await execute(cell);
      records[current] = record;
      await options.onComplete?.(record, cell);
    }
  };

  const workerCount = Math.min(concurrency, cells.length);
  const workers: Promise<void>[] = [];
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return records;
}
