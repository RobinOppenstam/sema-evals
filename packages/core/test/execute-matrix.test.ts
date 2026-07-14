import { describe, expect, it } from "vitest";

import { executeMatrix, type MatrixCell } from "../src/matrix.js";

function cell(index: number): MatrixCell<number, string> {
  return {
    scenario: index,
    scenarioId: `s${index}`,
    condition: "baseline",
    seed: 0,
    executionIndex: index,
    trialId: `t${index}`,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("executeMatrix", () => {
  it("defaults to strictly sequential execution in planned order", async () => {
    const cells = Array.from({ length: 4 }, (_, index) => cell(index));
    const startOrder: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const records = await executeMatrix(cells, async (current) => {
      startOrder.push(current.executionIndex);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return current.executionIndex;
    });

    expect(maxInFlight).toBe(1);
    expect(startOrder).toEqual([0, 1, 2, 3]);
    expect(records).toEqual([0, 1, 2, 3]);
  });

  it("keeps at most N trials in flight and still starts them in planned order", async () => {
    const cells = Array.from({ length: 9 }, (_, index) => cell(index));
    const startOrder: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const records = await executeMatrix(
      cells,
      async (current) => {
        startOrder.push(current.executionIndex);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Stagger completion so trials finish out of order.
        await new Promise((settle) =>
          setTimeout(settle, (current.executionIndex % 3) * 5),
        );
        inFlight -= 1;
        return `r${current.executionIndex}`;
      },
      { concurrency: 3 },
    );

    expect(maxInFlight).toBe(3);
    // The pool always claims the lowest not-yet-started cell, so start order
    // still follows the plan even though completion order does not.
    expect(startOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(records).toEqual([
      "r0",
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
      "r8",
    ]);
  });

  it("returns records in planned order even when completion order is reversed", async () => {
    const cells = Array.from({ length: 3 }, (_, index) => cell(index));
    const gates = cells.map(() => deferred<void>());
    const completionOrder: number[] = [];

    const run = executeMatrix(
      cells,
      async (current) => {
        const gate = gates[current.executionIndex];
        if (gate === undefined) {
          throw new Error("missing gate");
        }
        await gate.promise;
        completionOrder.push(current.executionIndex);
        return `r${current.executionIndex}`;
      },
      { concurrency: 3 },
    );

    // Release the trials in reverse so completion order is 2, 1, 0.
    for (const gate of [...gates].reverse()) {
      gate.resolve();
    }

    const records = await run;

    expect(completionOrder).toEqual([2, 1, 0]);
    expect(records).toEqual(["r0", "r1", "r2"]);
  });

  it("invokes onComplete once per trial in completion order", async () => {
    const cells = Array.from({ length: 3 }, (_, index) => cell(index));
    const gates = cells.map(() => deferred<void>());
    const seen: string[] = [];

    const run = executeMatrix(
      cells,
      async (current) => {
        const gate = gates[current.executionIndex];
        if (gate === undefined) {
          throw new Error("missing gate");
        }
        await gate.promise;
        return `r${current.executionIndex}`;
      },
      {
        concurrency: 3,
        onComplete: (record, matrixCell) => {
          seen.push(`${matrixCell.scenarioId}:${record}`);
        },
      },
    );

    for (const gate of [...gates].reverse()) {
      gate.resolve();
    }
    await run;

    expect(seen).toEqual(["s2:r2", "s1:r1", "s0:r0"]);
  });

  it("clamps concurrency below 1 to sequential execution", async () => {
    const cells = Array.from({ length: 3 }, (_, index) => cell(index));
    let inFlight = 0;
    let maxInFlight = 0;

    const records = await executeMatrix(
      cells,
      async (current) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return current.executionIndex;
      },
      { concurrency: 0 },
    );

    expect(maxInFlight).toBe(1);
    expect(records).toEqual([0, 1, 2]);
  });
});
