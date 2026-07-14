import { describe, expect, it } from "vitest";

import { SemaPythonReferenceProvider } from "../src/sema-python.js";

const integration = process.env.SEMA_PYTHON ? describe : describe.skip;

integration("official semahash Python integration", () => {
  it("uses canonicalization v2 and changes the word when meaning changes", async () => {
    const pythonCommand = process.env.SEMA_PYTHON;
    if (!pythonCommand) {
      throw new Error("SEMA_PYTHON is required for this integration test.");
    }
    const provider = new SemaPythonReferenceProvider({ pythonCommand });
    const metadata = await provider.metadata();
    const inclusive = await provider.reference("BoundaryRule", {
      mechanism: "Accept the exact boundary value.",
      gloss: "Inclusive threshold.",
      invariants: ["amount >= 100"],
    });
    const strict = await provider.reference("BoundaryRule", {
      mechanism: "Reject the exact boundary value.",
      gloss: "Strict threshold.",
      invariants: ["amount > 100"],
    });

    expect(metadata).toMatchObject({
      backend: "semahash-python-api",
      canonicalizationVersion: "v2",
      officialSema: true,
    });
    expect(metadata.semaVersion).toMatch(/^0\.3\./);
    expect(inclusive.full).toMatch(
      /^sema:BoundaryRule#mh:SHA-256:[a-f0-9]{64}$/,
    );
    expect(strict.full).toMatch(/^sema:BoundaryRule#mh:SHA-256:[a-f0-9]{64}$/);
    expect(inclusive.digest).not.toBe(strict.digest);
  });
});
