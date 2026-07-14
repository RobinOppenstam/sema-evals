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
import sys
from importlib.metadata import version

request = json.load(sys.stdin)
action = request.get("action")
package_version = version("semahash")

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

function assertSupportedSemaVersion(version: string): void {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) {
    throw new SemaPythonBridgeError(
      `Sema bridge returned an invalid package version: ${version}.`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 0 && minor < 3) {
    throw new SemaPythonBridgeError(
      `semahash ${version} predates canonicalization v2; install semahash>=0.3.0.`,
    );
  }
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
      if (outputBytes > MAX_BRIDGE_OUTPUT_BYTES) {
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
              ? ` Install semahash>=0.3.0 in ${pythonCommand} or pass --sema-python explicitly.`
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

  public metadata(): Promise<SemanticBackendMetadata> {
    this.metadataPromise ??= this.loadMetadata();
    return this.metadataPromise;
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
    assertSupportedSemaVersion(semaVersion);
    return {
      backend: requiredString(response, "backend", "Sema metadata bridge"),
      semaVersion,
      canonicalizationVersion: requiredString(
        response,
        "canonicalization_version",
        "Sema metadata bridge",
      ),
      officialSema: true,
    };
  }

  private async loadReference(
    handle: string,
    definition: Record<string, unknown>,
  ): Promise<SemanticReference> {
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
    assertSupportedSemaVersion(semaVersion);
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
