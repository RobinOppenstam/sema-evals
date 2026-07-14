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

export async function executeMatrix<Scenario, Condition, Record>(
  cells: readonly MatrixCell<Scenario, Condition>[],
  execute: (cell: MatrixCell<Scenario, Condition>) => Promise<Record>,
): Promise<Record[]> {
  const records: Record[] = [];
  for (const cell of cells) {
    records.push(await execute(cell));
  }
  return records;
}
