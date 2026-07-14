import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPromptSnapshot } from "@sema-evals/core";
import { describe, expect, it } from "vitest";

const PROMPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../prompts",
);

const BOUNDARIES = [
  "spec-to-plan",
  "plan-to-implementation",
  "implementation-to-audit",
] as const;

describe("babel-relay prompt snapshot", () => {
  it("loads the committed manifest without drift", async () => {
    const snapshot = await loadPromptSnapshot(PROMPTS_DIR);

    for (const boundary of BOUNDARIES) {
      expect(snapshot.prompts[boundary]?.content).toContain("Role:");
    }
    expect(snapshot.promptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps one frozen file per relay boundary", async () => {
    const snapshot = await loadPromptSnapshot(PROMPTS_DIR);

    expect(Object.keys(snapshot.prompts).sort()).toEqual(
      [...BOUNDARIES].sort(),
    );
    expect(snapshot.prompts["spec-to-plan"]?.file).toBe("spec-to-plan.md");
  });

  it("resolves prompt files relative to the manifest directory", async () => {
    const first = await loadPromptSnapshot(PROMPTS_DIR);
    const second = await loadPromptSnapshot(join(PROMPTS_DIR, "."));

    expect(first.promptDigest).toBe(second.promptDigest);
  });
});
