import { describe, expect, it, vi } from "vitest";

import {
  SemaPythonBridgeError,
  SemaPythonReferenceProvider,
  type PythonJsonRunner,
} from "../src/sema-python.js";

function metadataResponse(version = "0.3.0", canonicalization = "v2") {
  return {
    backend: "semahash-python-api",
    sema_version: version,
    canonicalization_version: canonicalization,
    official_sema: true,
  };
}

describe("SemaPythonReferenceProvider", () => {
  it("maps official bridge responses and caches metadata and references", async () => {
    const digest = "a".repeat(64);
    const runner = vi.fn<PythonJsonRunner>(async (_command, request) => {
      if (request.action === "metadata") {
        return metadataResponse();
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
    const runner: PythonJsonRunner = async (_command, request) =>
      request.action === "metadata"
        ? metadataResponse()
        : {
            full_id: "sema:BoundaryRule#mh:SHA-256:not-a-hash",
            reference: "BoundaryRule#nope",
            hash: "not-a-hash",
            sema_version: "0.3.0",
          };
    const provider = new SemaPythonReferenceProvider({ runner });

    await expect(
      provider.reference("BoundaryRule", { mechanism: "test" }),
    ).rejects.toThrow(SemaPythonBridgeError);
  });

  it.each(["0.2.9", "0.4.0", "1.0.0"])(
    "fails closed for unaudited semahash version %s",
    async (version) => {
      const runner: PythonJsonRunner = async () => metadataResponse(version);
      const provider = new SemaPythonReferenceProvider({ runner });

      await expect(provider.metadata()).rejects.toThrow(
        "supports the audited semahash 0.3.x line",
      );
    },
  );

  it("rejects canonicalization metadata inconsistent with semahash 0.3.x", async () => {
    const runner: PythonJsonRunner = async () =>
      metadataResponse("0.3.0", "v1");
    const provider = new SemaPythonReferenceProvider({ runner });

    await expect(provider.metadata()).rejects.toThrow(
      "should use v2, but the bridge reported v1",
    );
  });

  it("evicts failed metadata probes so a transient error can be retried", async () => {
    let metadataAttempts = 0;
    const runner: PythonJsonRunner = async () => {
      metadataAttempts += 1;
      if (metadataAttempts === 1) {
        throw new Error("transient metadata failure");
      }
      return metadataResponse();
    };
    const provider = new SemaPythonReferenceProvider({ runner });

    await expect(provider.metadata()).rejects.toThrow(
      "transient metadata failure",
    );
    await expect(provider.metadata()).resolves.toMatchObject({
      semaVersion: "0.3.0",
    });
    expect(metadataAttempts).toBe(2);
  });

  it("rejects a package-version change between metadata and hashing", async () => {
    const digest = "c".repeat(64);
    const runner: PythonJsonRunner = async (_command, request) =>
      request.action === "metadata"
        ? metadataResponse("0.3.0")
        : {
            full_id: `sema:VersionRule#mh:SHA-256:${digest}`,
            reference: "VersionRule#cccc",
            hash: digest,
            sema_version: "0.3.1",
          };
    const provider = new SemaPythonReferenceProvider({ runner });

    await expect(
      provider.reference("VersionRule", { mechanism: "version lock" }),
    ).rejects.toThrow("package version changed during the run");
  });

  it("evicts failed references so a transient bridge error can be retried", async () => {
    const digest = "b".repeat(64);
    let hashAttempts = 0;
    const runner: PythonJsonRunner = async (_command, request) => {
      if (request.action === "metadata") {
        return metadataResponse();
      }
      hashAttempts += 1;
      if (hashAttempts === 1) {
        throw new Error("transient hash failure");
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
    ).rejects.toThrow("transient hash failure");
    await expect(
      provider.reference("RetryRule", { mechanism: "retry" }),
    ).resolves.toMatchObject({ digest });
    expect(hashAttempts).toBe(2);
  });
});
