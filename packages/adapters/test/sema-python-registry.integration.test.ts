import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SemaPythonRegistryClient } from "../src/index.js";

const integration = process.env.SEMA_PYTHON ? describe : describe.skip;
const temporaryDirectories: string[] = [];

function pattern(mechanism: string) {
  return {
    handle: "BoundaryRule",
    mechanism,
    gloss: "An objectively testable boundary rule.",
    invariants: [mechanism],
    _meta: {
      path: ["Society", "Protocols"],
      ring: 2,
      tier: 3,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

integration("official Sema Python registry integration", () => {
  it("resolves aligned definitions and halts on pattern and vocabulary drift", async () => {
    const pythonCommand = process.env.SEMA_PYTHON;
    if (!pythonCommand) {
      throw new Error("SEMA_PYTHON is required for this integration test.");
    }
    const directory = await mkdtemp(join(tmpdir(), "sema-evals-registry-"));
    temporaryDirectories.push(directory);
    const canonicalPath = join(directory, "canonical.db");
    const driftedPath = join(directory, "drifted.db");
    const client = new SemaPythonRegistryClient({ pythonCommand });

    const canonical = await client.buildRegistry({
      dbPath: canonicalPath,
      workspaceId: "canonical",
      label: "Canonical fixture vocabulary",
      patterns: [pattern("Accept amount >= 100.")],
    });
    const drifted = await client.buildRegistry({
      dbPath: driftedPath,
      workspaceId: "drifted",
      label: "Drifted fixture vocabulary",
      patterns: [pattern("Accept amount > 100.")],
    });
    const canonicalIdentity = canonical.patterns[0];
    if (!canonicalIdentity) {
      throw new Error(
        "Canonical registry did not return its pattern identity.",
      );
    }

    const resolved = await client.resolve(canonicalPath, "BoundaryRule", 0);
    const aligned = await client.handshake(
      canonicalPath,
      "BoundaryRule",
      canonicalIdentity.digest,
    );
    const patternDrift = await client.handshake(
      driftedPath,
      "BoundaryRule",
      canonicalIdentity.digest,
    );
    const vocabularyDrift = await client.handshake(
      driftedPath,
      "vocab",
      canonical.workspace.vocabularyRoot,
    );

    expect(resolved.patterns.BoundaryRule?.mechanism).toBe(
      "Accept amount >= 100.",
    );
    expect(aligned.verdict).toBe("PROCEED");
    expect(patternDrift).toMatchObject({
      verdict: "HALT",
      reason: "SEMANTIC DRIFT DETECTED",
    });
    expect(vocabularyDrift).toMatchObject({
      verdict: "HALT",
      scope: "vocab",
      reason: "VOCABULARY DRIFT DETECTED",
    });
    expect(canonical.workspace.vocabularyRoot).not.toBe(
      drifted.workspace.vocabularyRoot,
    );
    expect(patternDrift.canonicalStub).toBe(drifted.patterns[0]?.stub);

    await expect(
      client.buildRegistry({
        dbPath: canonicalPath,
        patterns: [pattern("Do not overwrite this registry.")],
      }),
    ).rejects.toThrow("Refusing to overwrite existing registry");
    await expect(client.describe(canonicalPath)).resolves.toMatchObject({
      vocabularyRoot: canonical.workspace.vocabularyRoot,
    });

    const invalidPath = join(directory, "invalid.db");
    await expect(
      client.buildRegistry({
        dbPath: invalidPath,
        patterns: [
          {
            handle: "InvalidRule",
            mechanism: "This intentionally omits required Sema metadata.",
          },
        ],
      }),
    ).rejects.toThrow("could not mint InvalidRule");
    await expect(access(invalidPath)).rejects.toThrow();
  }, 30_000);
});
