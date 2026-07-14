import { describe, expect, it, vi } from "vitest";

import {
  SemaPythonBridgeError,
  SemaPythonReferenceProvider,
  type PythonJsonRunner,
} from "../src/sema-python.js";

describe("SemaPythonReferenceProvider", () => {
  it("maps official bridge responses and caches metadata and references", async () => {
    const digest = "a".repeat(64);
    const runner = vi.fn<PythonJsonRunner>(async (_command, request) => {
      if (request.action === "metadata") {
        return {
          backend: "semahash-python-api",
          sema_version: "0.3.0",
          canonicalization_version: "v2",
          official_sema: true,
        };
      }
      return {
        full_id: `sema:BoundaryRule#mh:SHA-256:${digest}`,
        reference: "BoundaryRule#aaaa",
        hash: digest,
        sema_version: "0.3.0",
      };
    });
    const provider = new SemaPythonReferenceProvider({
      pythonCommand: "test-python",
      runner,
    });

    const firstMetadata = await provider.metadata();
    const secondMetadata = await provider.metadata();
    const firstReference = await provider.reference("BoundaryRule", {
      mechanism: "Use the inclusive threshold.",
    });
    const secondReference = await provider.reference("BoundaryRule", {
      mechanism: "Use the inclusive threshold.",
    });

    expect(firstMetadata).toEqual(secondMetadata);
    expect(firstMetadata).toMatchObject({
      semaVersion: "0.3.0",
      canonicalizationVersion: "v2",
      officialSema: true,
    });
    expect(firstReference).toEqual(secondReference);
    expect(firstReference).toMatchObject({
      display: "BoundaryRule#aaaa",
      digest,
      officialSema: true,
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed hash responses", async () => {
    const runner: PythonJsonRunner = async () => ({
      full_id: "sema:BoundaryRule#mh:SHA-256:not-a-hash",
      reference: "BoundaryRule#nope",
      hash: "not-a-hash",
      sema_version: "0.3.0",
    });
    const provider = new SemaPythonReferenceProvider({ runner });

    await expect(
      provider.reference("BoundaryRule", { mechanism: "test" }),
    ).rejects.toThrow(SemaPythonBridgeError);
  });

  it("rejects semahash versions that predate canonicalization v2", async () => {
    const runner: PythonJsonRunner = async () => ({
      backend: "semahash-python-api",
      sema_version: "0.2.9",
      canonicalization_version: "v1",
      official_sema: true,
    });
    const provider = new SemaPythonReferenceProvider({ runner });

    await expect(provider.metadata()).rejects.toThrow(
      "install semahash>=0.3.0",
    );
  });

  it("evicts failed references so a transient bridge error can be retried", async () => {
    const digest = "b".repeat(64);
    let attempt = 0;
    const runner: PythonJsonRunner = async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      return {
        full_id: `sema:RetryRule#mh:SHA-256:${digest}`,
        reference: "RetryRule#bbbb",
        hash: digest,
        sema_version: "0.3.0",
      };
    };
    const provider = new SemaPythonReferenceProvider({ runner });

    await expect(
      provider.reference("RetryRule", { mechanism: "retry" }),
    ).rejects.toThrow("transient failure");
    await expect(
      provider.reference("RetryRule", { mechanism: "retry" }),
    ).resolves.toMatchObject({ digest });
    expect(attempt).toBe(2);
  });
});
