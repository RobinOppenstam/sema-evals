import { describe, expect, it, vi } from "vitest";

import {
  SemaPythonBridgeError,
  SemaPythonRegistryClient,
  type PythonJsonRunner,
} from "../src/index.js";

const DIGEST = "a".repeat(64);
const DB_PATH = "/tmp/sema-evals-registry.db";

function metadataResponse(version = "0.3.0") {
  return {
    backend: "semahash-python-api",
    sema_version: version,
    canonicalization_version: "v2",
    official_sema: true,
  };
}

function workspaceResponse() {
  const root = "b".repeat(64);
  return {
    workspace_id: "test-workspace",
    label: "Test workspace",
    read_only: true,
    db_path: DB_PATH,
    data_source: "database",
    pattern_count: 1,
    vocabulary_root: root,
    vocabulary_root_stub: root.slice(0, 16),
  };
}

function identityResponse() {
  return {
    handle: "BoundaryRule",
    sema_ref: "BoundaryRule#aaaa",
    sema_id: `sema:BoundaryRule#mh:SHA-256:${DIGEST}`,
    sema_stub: "aaaa",
  };
}

describe("SemaPythonRegistryClient", () => {
  it("maps official registry, resolution, and handshake responses", async () => {
    const runner = vi.fn<PythonJsonRunner>(async (_command, request) => {
      switch (request.action) {
        case "metadata":
          return metadataResponse();
        case "registry_build":
          return {
            db_path: DB_PATH,
            patterns: [identityResponse()],
            workspace: workspaceResponse(),
            sema_version: "0.3.0",
          };
        case "workspace_describe":
          return { result: workspaceResponse(), sema_version: "0.3.0" };
        case "workspace_lookup":
          return {
            result: { ...identityResponse(), mechanism: "Use the boundary." },
            sema_version: "0.3.0",
          };
        case "workspace_resolve":
          return {
            result: {
              root: "BoundaryRule",
              depth: 0,
              count: 1,
              patterns: {
                BoundaryRule: {
                  ...identityResponse(),
                  mechanism: "Use the boundary.",
                },
              },
            },
            sema_version: "0.3.0",
          };
        case "workspace_handshake":
          return {
            result: {
              verdict: "PROCEED",
              handle: "BoundaryRule",
              verified_ref: "BoundaryRule#aaaa",
            },
            sema_version: "0.3.0",
          };
        default:
          throw new Error(`unexpected action: ${String(request.action)}`);
      }
    });
    const client = new SemaPythonRegistryClient({
      pythonCommand: "test-python",
      runner,
    });

    const build = await client.buildRegistry({
      dbPath: DB_PATH,
      workspaceId: "test-workspace",
      label: "Test workspace",
      patterns: [{ handle: "BoundaryRule", mechanism: "Use the boundary." }],
    });
    const described = await client.describe(DB_PATH);
    const lookup = await client.lookup(DB_PATH, "BoundaryRule");
    const resolved = await client.resolve(DB_PATH, "BoundaryRule");
    const handshake = await client.handshake(DB_PATH, "BoundaryRule", DIGEST);

    expect(build.patterns[0]).toMatchObject({
      handle: "BoundaryRule",
      digest: DIGEST,
      display: "BoundaryRule#aaaa",
    });
    expect(build.workspace.vocabularyRoot).toBe("b".repeat(64));
    expect(described.patternCount).toBe(1);
    expect(lookup.pattern.mechanism).toBe("Use the boundary.");
    expect(resolved.patterns.BoundaryRule?.mechanism).toBe("Use the boundary.");
    expect(handshake).toMatchObject({
      verdict: "PROCEED",
      scope: "pattern",
      verifiedReference: "BoundaryRule#aaaa",
    });
    expect(runner).toHaveBeenCalledTimes(6);
    expect(
      runner.mock.calls.filter(([, request]) => request.action === "metadata"),
    ).toHaveLength(1);
  });

  it("rejects relative registry paths before invoking a workspace action", async () => {
    const runner = vi.fn<PythonJsonRunner>(async () => metadataResponse());
    const client = new SemaPythonRegistryClient({ runner });

    await expect(client.describe("relative.db")).rejects.toThrow(
      "registry paths must be absolute",
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects malformed identities returned by a registry build", async () => {
    const runner: PythonJsonRunner = async (_command, request) =>
      request.action === "metadata"
        ? metadataResponse()
        : {
            db_path: DB_PATH,
            patterns: [
              {
                ...identityResponse(),
                sema_ref: "BoundaryRule#ffff",
              },
            ],
            workspace: workspaceResponse(),
            sema_version: "0.3.0",
          };
    const client = new SemaPythonRegistryClient({ runner });

    await expect(
      client.buildRegistry({
        dbPath: DB_PATH,
        patterns: [{ handle: "BoundaryRule", mechanism: "Use the boundary." }],
      }),
    ).rejects.toThrow(SemaPythonBridgeError);
  });

  it("fails closed if the package version changes during workspace access", async () => {
    const runner: PythonJsonRunner = async (_command, request) =>
      request.action === "metadata"
        ? metadataResponse("0.3.0")
        : { result: workspaceResponse(), sema_version: "0.3.1" };
    const client = new SemaPythonRegistryClient({ runner });

    await expect(client.describe(DB_PATH)).rejects.toThrow(
      "package version changed during the run",
    );
  });
});
