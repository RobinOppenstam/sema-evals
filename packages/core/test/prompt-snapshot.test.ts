import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PromptSnapshotError,
  loadPromptSnapshot,
  sha256Text,
} from "../src/index.js";

let directory: string;

const SPEC = "Spec prompt body.\n";
const PLAN = "Plan prompt body.\n";

async function writeManifest(
  overrides: Record<string, { file: string; sha256: string }> = {},
): Promise<void> {
  const prompts = {
    "spec-to-plan": { file: "spec.md", sha256: sha256Text(SPEC) },
    "plan-to-implementation": { file: "plan.md", sha256: sha256Text(PLAN) },
    ...overrides,
  };
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ snapshotVersion: "test-1", prompts }, null, 2),
    "utf8",
  );
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "prompt-snapshot-"));
  await writeFile(join(directory, "spec.md"), SPEC, "utf8");
  await writeFile(join(directory, "plan.md"), PLAN, "utf8");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("loadPromptSnapshot", () => {
  it("loads a valid manifest and exposes each prompt body", async () => {
    await writeManifest();

    const snapshot = await loadPromptSnapshot(directory);

    expect(snapshot.snapshotVersion).toBe("test-1");
    expect(snapshot.prompts["spec-to-plan"]?.content).toBe(SPEC);
    expect(snapshot.prompts["plan-to-implementation"]?.content).toBe(PLAN);
    expect(snapshot.promptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces a deterministic combined promptDigest", async () => {
    await writeManifest();

    const first = await loadPromptSnapshot(directory);
    const second = await loadPromptSnapshot(directory);

    expect(first.promptDigest).toBe(second.promptDigest);
  });

  it("refuses to load when a file no longer matches its manifest digest", async () => {
    await writeManifest();
    await writeFile(join(directory, "spec.md"), "tampered body\n", "utf8");

    await expect(loadPromptSnapshot(directory)).rejects.toBeInstanceOf(
      PromptSnapshotError,
    );
    await expect(loadPromptSnapshot(directory)).rejects.toThrow(
      /refusing to load a drifted prompt/,
    );
  });

  it("refuses to load when a listed file is missing", async () => {
    await writeManifest({
      absent: { file: "missing.md", sha256: sha256Text("x") },
    });

    await expect(loadPromptSnapshot(directory)).rejects.toBeInstanceOf(
      PromptSnapshotError,
    );
  });

  it("refuses to load a malformed manifest", async () => {
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({ snapshotVersion: "test-1", prompts: {} }),
      "utf8",
    );

    await expect(loadPromptSnapshot(directory)).rejects.toBeInstanceOf(
      PromptSnapshotError,
    );
  });
});
