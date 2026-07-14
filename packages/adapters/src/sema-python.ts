import { spawn } from "node:child_process";

import { fingerprint } from "@sema-evals/core";

import type {
  SemanticBackendMetadata,
  SemanticReference,
  SemanticReferenceProvider,
} from "./semantic-reference.js";

const MAX_BRIDGE_OUTPUT_BYTES = 1_000_000;

const PYTHON_BRIDGE = String.raw`
import json
import os
import sys
import tempfile
import uuid
from importlib.metadata import version
from pathlib import Path

request = json.load(sys.stdin)
action = request.get("action")
package_version = version("semahash")


def workspace_for(db_path, workspace_id="local", label="Local vocabulary"):
    from sema.core.workspace import GraphWorkspace, WorkspaceSource

    if not isinstance(db_path, str) or not db_path:
        raise ValueError("workspace requests require a non-empty db_path")
    resolved = Path(db_path).expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"Sema registry not found: {resolved}")
    source = WorkspaceSource(
        workspace_id=workspace_id,
        label=label,
        db_path=str(resolved),
        vocab_dir=str(resolved.parent),
        read_only=True,
    )
    return GraphWorkspace(source)

if action == "metadata":
    response = {
        "backend": "semahash-python-api",
        "sema_version": package_version,
        "canonicalization_version": "v2",
        "official_sema": True,
    }
elif action == "hash":
    from sema.core.hashing import generate_sema_hash

    definition = request.get("definition")
    handle = request.get("handle")
    if not isinstance(definition, dict) or not isinstance(handle, str):
        raise ValueError("hash requests require a string handle and object definition")

    pattern = dict(definition)
    pattern["handle"] = handle
    result = generate_sema_hash(pattern)
    response = {
        "full_id": result["full_id"],
        "reference": result["reference"],
        "hash": result["hash"],
        "sema_version": package_version,
    }
elif action == "registry_build":
    import numpy as np

    from sema.core.mint import mint_pattern
    from sema.taxonomy_graph.graph_store import GraphStore

    db_path = request.get("db_path")
    patterns = request.get("patterns")
    if not isinstance(db_path, str) or not db_path:
        raise ValueError("registry_build requires a non-empty db_path")
    if not isinstance(patterns, list) or not patterns:
        raise ValueError("registry_build requires a non-empty patterns list")
    if not all(isinstance(pattern, dict) for pattern in patterns):
        raise ValueError("registry_build patterns must be objects")

    target = Path(db_path).expanduser().resolve()
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite existing registry: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    previous_cache_dir = os.environ.get("SEMA_CACHE_DIR")

    try:
        with tempfile.TemporaryDirectory(prefix="sema-evals-cache-") as cache_dir:
            os.environ["SEMA_CACHE_DIR"] = cache_dir
            store = GraphStore(str(scratch))
            store.embedding_service.get_embedding = lambda _text: np.zeros(
                store.embedding_service.EMBEDDING_DIM, dtype=np.float32
            )
            minted_handles = set()
            minted = []
            for raw_pattern in patterns:
                pattern = dict(raw_pattern)
                handle = pattern.get("handle")
                if not isinstance(handle, str) or not handle:
                    raise ValueError("every registry pattern requires a non-empty handle")
                if handle in minted_handles:
                    raise ValueError(f"duplicate registry pattern handle: {handle}")
                result = mint_pattern(pattern, store, known_handles=minted_handles)
                if not result.success:
                    raise ValueError(
                        f"could not mint {handle}: " + "; ".join(result.errors)
                    )
                minted_handles.add(handle)
                minted.append(
                    {
                        "handle": handle,
                        "sema_ref": result.sema_ref,
                        "sema_id": result.sema_id,
                        "sema_stub": result.sema_stub,
                    }
                )
        os.replace(scratch, target)
    except Exception:
        scratch.unlink(missing_ok=True)
        raise
    finally:
        if previous_cache_dir is None:
            os.environ.pop("SEMA_CACHE_DIR", None)
        else:
            os.environ["SEMA_CACHE_DIR"] = previous_cache_dir

    workspace_id = request.get("workspace_id", "local")
    label = request.get("label", "Local vocabulary")
    workspace = workspace_for(str(target), workspace_id=workspace_id, label=label)
    response = {
        "db_path": str(target),
        "patterns": minted,
        "workspace": workspace.describe(),
        "sema_version": package_version,
    }
elif action in {
    "workspace_describe",
    "workspace_lookup",
    "workspace_resolve",
    "workspace_handshake",
}:
    workspace = workspace_for(
        request.get("db_path"),
        workspace_id=request.get("workspace_id", "local"),
        label=request.get("label", "Local vocabulary"),
    )
    if action == "workspace_describe":
        result = workspace.describe()
    elif action == "workspace_lookup":
        ref = request.get("ref")
        if not isinstance(ref, str) or not ref:
            raise ValueError("workspace_lookup requires a non-empty ref")
        result = workspace.lookup(ref)
    elif action == "workspace_resolve":
        handle = request.get("handle")
        depth = request.get("depth", 0)
        if not isinstance(handle, str) or not handle:
            raise ValueError("workspace_resolve requires a non-empty handle")
        if not isinstance(depth, int) or isinstance(depth, bool) or depth < 0:
            raise ValueError("workspace_resolve depth must be a non-negative integer")
        result = workspace.resolve(handle, depth=depth)
    else:
        ref = request.get("ref")
        your_hash = request.get("your_hash")
        if not isinstance(ref, str) or not ref:
            raise ValueError("workspace_handshake requires a non-empty ref")
        if your_hash is not None and not isinstance(your_hash, str):
            raise ValueError("workspace_handshake your_hash must be a string or null")
        result = workspace.handshake(ref, your_hash=your_hash)
    response = {"result": result, "sema_version": package_version}
else:
    raise ValueError(f"unsupported bridge action: {action!r}")

json.dump(response, sys.stdout, ensure_ascii=False, separators=(",", ":"))
`;

export type PythonJsonRunner = (
  pythonCommand: string,
  request: Record<string, unknown>,
  timeoutMs: number,
) => Promise<unknown>;

export interface SemaPythonReferenceProviderOptions {
  pythonCommand?: string;
  timeoutMs?: number;
  runner?: PythonJsonRunner;
}

export class SemaPythonBridgeError extends Error {
  public override readonly name = "SemaPythonBridgeError";
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SemaPythonBridgeError(
      `${context} returned a non-object response.`,
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new SemaPythonBridgeError(`${context} returned an invalid ${field}.`);
  }
  return candidate;
}

function canonicalizationForSemaVersion(version: string): "v2" {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[+.-].*)?$/.exec(version);
  if (!match) {
    throw new SemaPythonBridgeError(
      `Sema bridge returned an invalid package version: ${version}.`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 0 || minor !== 3) {
    throw new SemaPythonBridgeError(
      `This adapter supports the audited semahash 0.3.x line; received ${version}.`,
    );
  }
  return "v2";
}

export const runPythonJson: PythonJsonRunner = (
  pythonCommand,
  request,
  timeoutMs,
) =>
  new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, ["-c", PYTHON_BRIDGE], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new SemaPythonBridgeError(
            `Sema Python bridge timed out after ${timeoutMs} ms using ${pythonCommand}.`,
          ),
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes + errorBytes > MAX_BRIDGE_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new SemaPythonBridgeError(
              "Sema Python bridge exceeded its output limit.",
            ),
          ),
        );
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (outputBytes + errorBytes > MAX_BRIDGE_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new SemaPythonBridgeError(
              "Sema Python bridge exceeded its output limit.",
            ),
          ),
        );
        return;
      }
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      finish(() =>
        reject(
          new SemaPythonBridgeError(
            `Could not start Sema Python bridge with ${pythonCommand}: ${error.message}`,
          ),
        ),
      );
    });

    child.on("close", (code) => {
      finish(() => {
        const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0) {
          const installHint =
            /PackageNotFoundError|No module named ['"]sema/.test(errorOutput)
              ? ` Install semahash>=0.3.0,<0.4.0 in ${pythonCommand} or pass --sema-python explicitly.`
              : "";
          reject(
            new SemaPythonBridgeError(
              `Sema Python bridge exited with code ${String(code)}${
                errorOutput ? `: ${errorOutput}` : "."
              }${installHint}`,
            ),
          );
          return;
        }

        try {
          resolve(
            JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          reject(
            new SemaPythonBridgeError(
              `Sema Python bridge returned invalid JSON: ${reason}`,
            ),
          );
        }
      });
    });

    child.stdin.on("error", (error) => {
      finish(() =>
        reject(
          new SemaPythonBridgeError(
            `Could not write to Sema Python bridge: ${error.message}`,
          ),
        ),
      );
    });
    child.stdin.end(JSON.stringify(request));
  });

export class SemaPythonReferenceProvider implements SemanticReferenceProvider {
  public readonly backend = "semahash-python-api";
  private readonly pythonCommand: string;
  private readonly timeoutMs: number;
  private readonly runner: PythonJsonRunner;
  private metadataPromise: Promise<SemanticBackendMetadata> | undefined;
  private readonly referenceCache = new Map<
    string,
    Promise<SemanticReference>
  >();

  public constructor(options: SemaPythonReferenceProviderOptions = {}) {
    this.pythonCommand = options.pythonCommand ?? "python3";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.runner = options.runner ?? runPythonJson;
  }

  public async metadata(): Promise<SemanticBackendMetadata> {
    try {
      this.metadataPromise ??= this.loadMetadata();
      return await this.metadataPromise;
    } catch (error) {
      this.metadataPromise = undefined;
      throw error;
    }
  }

  public reference(
    handle: string,
    definition: Record<string, unknown>,
  ): Promise<SemanticReference> {
    const cacheKey = fingerprint({ handle, definition });
    const cached = this.referenceCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = this.loadReference(handle, definition).catch(
      (error: unknown) => {
        this.referenceCache.delete(cacheKey);
        throw error;
      },
    );
    this.referenceCache.set(cacheKey, pending);
    return pending;
  }

  private async loadMetadata(): Promise<SemanticBackendMetadata> {
    const response = asRecord(
      await this.runner(
        this.pythonCommand,
        { action: "metadata" },
        this.timeoutMs,
      ),
      "Sema metadata bridge",
    );
    if (response.official_sema !== true) {
      throw new SemaPythonBridgeError(
        "Sema metadata bridge did not identify an official backend.",
      );
    }
    const semaVersion = requiredString(
      response,
      "sema_version",
      "Sema metadata bridge",
    );
    const expectedCanonicalization =
      canonicalizationForSemaVersion(semaVersion);
    const reportedCanonicalization = requiredString(
      response,
      "canonicalization_version",
      "Sema metadata bridge",
    );
    if (reportedCanonicalization !== expectedCanonicalization) {
      throw new SemaPythonBridgeError(
        `semahash ${semaVersion} should use ${expectedCanonicalization}, but the bridge reported ${reportedCanonicalization}.`,
      );
    }
    return {
      backend: requiredString(response, "backend", "Sema metadata bridge"),
      semaVersion,
      canonicalizationVersion: expectedCanonicalization,
      officialSema: true,
    };
  }

  private async loadReference(
    handle: string,
    definition: Record<string, unknown>,
  ): Promise<SemanticReference> {
    const metadata = await this.metadata();
    const response = asRecord(
      await this.runner(
        this.pythonCommand,
        { action: "hash", handle, definition },
        this.timeoutMs,
      ),
      "Sema hash bridge",
    );
    const semaVersion = requiredString(
      response,
      "sema_version",
      "Sema hash bridge",
    );
    canonicalizationForSemaVersion(semaVersion);
    if (semaVersion !== metadata.semaVersion) {
      throw new SemaPythonBridgeError(
        `Sema package version changed during the run: ${metadata.semaVersion} -> ${semaVersion}.`,
      );
    }
    const digest = requiredString(response, "hash", "Sema hash bridge");
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new SemaPythonBridgeError(
        "Sema hash bridge returned a non-SHA-256 digest.",
      );
    }
    const display = requiredString(response, "reference", "Sema hash bridge");
    const full = requiredString(response, "full_id", "Sema hash bridge");
    if (!full.startsWith("sema:") || !full.endsWith(`#mh:SHA-256:${digest}`)) {
      throw new SemaPythonBridgeError(
        "Sema hash bridge returned an inconsistent full_id.",
      );
    }
    if (!display.endsWith(`#${digest.slice(0, 4)}`)) {
      throw new SemaPythonBridgeError(
        "Sema hash bridge returned an inconsistent short reference.",
      );
    }

    return {
      handle,
      display,
      full,
      digest,
      backend: this.backend,
      officialSema: true,
    };
  }
}
