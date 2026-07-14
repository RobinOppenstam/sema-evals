import { isAbsolute, resolve } from "node:path";

import {
  runPythonJson,
  SemaPythonBridgeError,
  SemaPythonReferenceProvider,
  type PythonJsonRunner,
} from "./sema-python.js";
import type { SemanticBackendMetadata } from "./semantic-reference.js";

export type SemaHandshakeVerdict = "PROVIDE_HASH" | "PROCEED" | "HALT";

export interface SemaRegistryPatternInput extends Record<string, unknown> {
  handle: string;
}

export interface SemaRegistryPatternIdentity {
  handle: string;
  display: string;
  full: string;
  digest: string;
  stub: string;
}

export interface SemaWorkspaceDescription {
  workspaceId: string;
  label: string;
  readOnly: boolean;
  dbPath: string;
  dataSource: string;
  patternCount: number;
  vocabularyRoot: string;
  vocabularyRootStub: string;
}

export interface SemaRegistryBuildOptions {
  dbPath: string;
  patterns: readonly SemaRegistryPatternInput[];
  workspaceId?: string;
  label?: string;
}

export interface SemaRegistryBuildResult {
  dbPath: string;
  patterns: SemaRegistryPatternIdentity[];
  workspace: SemaWorkspaceDescription;
}

export interface SemaWorkspaceLookupResult {
  pattern: Record<string, unknown>;
  warning?: string;
}

export interface SemaWorkspaceResolveResult {
  root: string;
  depth: number;
  count: number;
  patterns: Record<string, Record<string, unknown>>;
}

export interface SemaHandshakeResult {
  verdict: SemaHandshakeVerdict;
  scope: "pattern" | "vocab";
  handle?: string;
  canonicalStub?: string;
  canonicalReference?: string;
  fullSemaId?: string;
  verifiedReference?: string;
  providedHash?: string;
  reason?: string;
  action?: string;
  patternCount?: number;
  details: Record<string, unknown>;
}

export interface SemaPythonRegistryClientOptions {
  pythonCommand?: string;
  timeoutMs?: number;
  runner?: PythonJsonRunner;
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

function optionalString(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function requiredInteger(
  value: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const candidate = value[field];
  if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) {
    throw new SemaPythonBridgeError(`${context} returned an invalid ${field}.`);
  }
  return Number(candidate);
}

function absoluteDbPath(dbPath: string): string {
  if (!isAbsolute(dbPath)) {
    throw new SemaPythonBridgeError(
      `Sema registry paths must be absolute; received ${dbPath}.`,
    );
  }
  return resolve(dbPath);
}

function parseIdentity(
  value: unknown,
  context: string,
): SemaRegistryPatternIdentity {
  const record = asRecord(value, context);
  const handle = requiredString(record, "handle", context);
  const display = requiredString(record, "sema_ref", context);
  const full = requiredString(record, "sema_id", context);
  const stub = requiredString(record, "sema_stub", context);
  const marker = "#mh:SHA-256:";
  const markerIndex = full.indexOf(marker);
  const digest =
    markerIndex === -1 ? "" : full.slice(markerIndex + marker.length);

  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new SemaPythonBridgeError(
      `${context} returned an invalid Sema SHA-256 identity.`,
    );
  }
  if (
    full !== `sema:${handle}${marker}${digest}` ||
    stub !== digest.slice(0, 4) ||
    display !== `${handle}#${stub}`
  ) {
    throw new SemaPythonBridgeError(
      `${context} returned inconsistent identity fields.`,
    );
  }

  return { handle, display, full, digest, stub };
}

function parseWorkspace(
  value: unknown,
  context: string,
): SemaWorkspaceDescription {
  const record = asRecord(value, context);
  const vocabularyRoot = requiredString(record, "vocabulary_root", context);
  const vocabularyRootStub = requiredString(
    record,
    "vocabulary_root_stub",
    context,
  );
  const readOnly = record.read_only;
  if (readOnly !== true && readOnly !== false) {
    throw new SemaPythonBridgeError(
      `${context} returned an invalid read_only flag.`,
    );
  }
  if (
    !/^[a-f0-9]{64}$/.test(vocabularyRoot) ||
    vocabularyRootStub !== vocabularyRoot.slice(0, 16)
  ) {
    throw new SemaPythonBridgeError(
      `${context} returned an inconsistent vocabulary root.`,
    );
  }

  return {
    workspaceId: requiredString(record, "workspace_id", context),
    label: requiredString(record, "label", context),
    readOnly,
    dbPath: requiredString(record, "db_path", context),
    dataSource: requiredString(record, "data_source", context),
    patternCount: requiredInteger(record, "pattern_count", context),
    vocabularyRoot,
    vocabularyRootStub,
  };
}

function parseVerdict(value: unknown, context: string): SemaHandshakeVerdict {
  if (value === "PROVIDE_HASH" || value === "PROCEED" || value === "HALT") {
    return value;
  }
  throw new SemaPythonBridgeError(`${context} returned an invalid verdict.`);
}

/**
 * Calls the official Sema 0.3.x workspace API with an explicit registry path.
 * It never reads or changes the process-wide active Sema registry.
 */
export class SemaPythonRegistryClient {
  public readonly backend = "semahash-python-workspace-api";
  private readonly pythonCommand: string;
  private readonly timeoutMs: number;
  private readonly runner: PythonJsonRunner;
  private readonly referenceProvider: SemaPythonReferenceProvider;

  public constructor(options: SemaPythonRegistryClientOptions = {}) {
    this.pythonCommand = options.pythonCommand ?? "python3";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.runner = options.runner ?? runPythonJson;
    this.referenceProvider = new SemaPythonReferenceProvider({
      pythonCommand: this.pythonCommand,
      timeoutMs: this.timeoutMs,
      runner: this.runner,
    });
  }

  public async metadata(): Promise<SemanticBackendMetadata> {
    return {
      ...(await this.referenceProvider.metadata()),
      backend: this.backend,
    };
  }

  /**
   * Atomically mints a new registry and refuses to overwrite an existing file.
   * Patterns with dependencies must be supplied in dependency-first order.
   */
  public async buildRegistry(
    options: SemaRegistryBuildOptions,
  ): Promise<SemaRegistryBuildResult> {
    if (options.patterns.length === 0) {
      throw new SemaPythonBridgeError(
        "Sema registry builds require at least one pattern.",
      );
    }
    const expectedHandles = options.patterns.map((pattern) => pattern.handle);
    if (
      expectedHandles.some((handle) => !handle) ||
      new Set(expectedHandles).size !== expectedHandles.length
    ) {
      throw new SemaPythonBridgeError(
        "Sema registry builds require unique non-empty pattern handles.",
      );
    }
    const dbPath = absoluteDbPath(options.dbPath);
    const response = await this.invoke(
      "registry_build",
      {
        db_path: dbPath,
        patterns: options.patterns,
        workspace_id: options.workspaceId ?? "local",
        label: options.label ?? "Local vocabulary",
      },
      "Sema registry build bridge",
    );
    const returnedPath = requiredString(
      response,
      "db_path",
      "Sema registry build bridge",
    );
    if (returnedPath !== dbPath) {
      throw new SemaPythonBridgeError(
        "Sema registry build bridge returned a different database path.",
      );
    }
    const rawPatterns = response.patterns;
    if (
      !Array.isArray(rawPatterns) ||
      rawPatterns.length !== options.patterns.length
    ) {
      throw new SemaPythonBridgeError(
        "Sema registry build bridge returned an invalid patterns list.",
      );
    }

    const patterns = rawPatterns.map((pattern, index) =>
      parseIdentity(pattern, `Sema registry pattern ${String(index)}`),
    );
    const returnedHandles = patterns.map((pattern) => pattern.handle).sort();
    if (
      JSON.stringify(returnedHandles) !==
      JSON.stringify([...expectedHandles].sort())
    ) {
      throw new SemaPythonBridgeError(
        "Sema registry build bridge returned a different pattern set.",
      );
    }
    const workspace = parseWorkspace(
      response.workspace,
      "Sema registry build workspace",
    );
    if (
      workspace.dbPath !== dbPath ||
      workspace.patternCount !== patterns.length
    ) {
      throw new SemaPythonBridgeError(
        "Sema registry build bridge returned inconsistent workspace metadata.",
      );
    }

    return {
      dbPath,
      patterns,
      workspace,
    };
  }

  public async describe(dbPath: string): Promise<SemaWorkspaceDescription> {
    const expectedPath = absoluteDbPath(dbPath);
    const result = await this.workspaceAction(
      "workspace_describe",
      expectedPath,
      {},
      "Sema workspace description bridge",
    );
    const workspace = parseWorkspace(
      result,
      "Sema workspace description bridge",
    );
    if (workspace.dbPath !== expectedPath) {
      throw new SemaPythonBridgeError(
        "Sema workspace description returned a different database path.",
      );
    }
    return workspace;
  }

  public async lookup(
    dbPath: string,
    ref: string,
  ): Promise<SemaWorkspaceLookupResult> {
    const result = asRecord(
      await this.workspaceAction(
        "workspace_lookup",
        dbPath,
        { ref },
        "Sema workspace lookup bridge",
      ),
      "Sema workspace lookup bridge",
    );
    const error = optionalString(result, "error");
    if (error) {
      throw new SemaPythonBridgeError(error);
    }
    const warning = optionalString(result, "warning");
    const pattern = warning
      ? asRecord(result.pattern, "Sema workspace lookup pattern")
      : result;
    return { pattern, ...(warning ? { warning } : {}) };
  }

  public async resolve(
    dbPath: string,
    handle: string,
    depth = 0,
  ): Promise<SemaWorkspaceResolveResult> {
    if (!Number.isSafeInteger(depth) || depth < 0) {
      throw new SemaPythonBridgeError(
        "Sema workspace resolution depth must be a non-negative integer.",
      );
    }
    const result = asRecord(
      await this.workspaceAction(
        "workspace_resolve",
        dbPath,
        { handle, depth },
        "Sema workspace resolution bridge",
      ),
      "Sema workspace resolution bridge",
    );
    const error = optionalString(result, "error");
    if (error) {
      throw new SemaPythonBridgeError(error);
    }
    const rawPatterns = asRecord(
      result.patterns,
      "Sema workspace resolution patterns",
    );
    const patterns = Object.fromEntries(
      Object.entries(rawPatterns).map(([key, pattern]) => [
        key,
        asRecord(pattern, `Sema resolved pattern ${key}`),
      ]),
    );
    const count = requiredInteger(
      result,
      "count",
      "Sema workspace resolution bridge",
    );
    if (Object.keys(patterns).length !== count) {
      throw new SemaPythonBridgeError(
        "Sema workspace resolution returned an inconsistent pattern count.",
      );
    }
    return {
      root: requiredString(result, "root", "Sema workspace resolution bridge"),
      depth: requiredInteger(
        result,
        "depth",
        "Sema workspace resolution bridge",
      ),
      count,
      patterns,
    };
  }

  public async handshake(
    dbPath: string,
    ref: string,
    yourHash?: string,
  ): Promise<SemaHandshakeResult> {
    const result = asRecord(
      await this.workspaceAction(
        "workspace_handshake",
        dbPath,
        { ref, ...(yourHash === undefined ? {} : { your_hash: yourHash }) },
        "Sema workspace handshake bridge",
      ),
      "Sema workspace handshake bridge",
    );
    const scope = result.scope === "vocab" ? "vocab" : "pattern";
    const patternCount = result.pattern_count;
    if (
      patternCount !== undefined &&
      (!Number.isSafeInteger(patternCount) || Number(patternCount) < 0)
    ) {
      throw new SemaPythonBridgeError(
        "Sema workspace handshake bridge returned an invalid pattern_count.",
      );
    }
    const handle = optionalString(result, "handle");
    const canonicalStub =
      optionalString(result, "canonical_stub") ??
      optionalString(result, "canonical_hash");
    const canonicalReference = optionalString(result, "canonical_ref");
    const fullSemaId = optionalString(result, "full_sema_id");
    const verifiedReference = optionalString(result, "verified_ref");
    const providedHash = optionalString(result, "your_hash");
    const reason = optionalString(result, "reason");
    const actionMessage = optionalString(result, "action");

    return {
      verdict: parseVerdict(result.verdict, "Sema workspace handshake bridge"),
      scope,
      ...(handle ? { handle } : {}),
      ...(canonicalStub ? { canonicalStub } : {}),
      ...(canonicalReference ? { canonicalReference } : {}),
      ...(fullSemaId ? { fullSemaId } : {}),
      ...(verifiedReference ? { verifiedReference } : {}),
      ...(providedHash ? { providedHash } : {}),
      ...(reason ? { reason } : {}),
      ...(actionMessage ? { action: actionMessage } : {}),
      ...(patternCount === undefined
        ? {}
        : { patternCount: Number(patternCount) }),
      details: result,
    };
  }

  private async workspaceAction(
    action: string,
    dbPath: string,
    payload: Record<string, unknown>,
    context: string,
  ): Promise<unknown> {
    const response = await this.invoke(
      action,
      { db_path: absoluteDbPath(dbPath), ...payload },
      context,
    );
    return response.result;
  }

  private async invoke(
    action: string,
    payload: Record<string, unknown>,
    context: string,
  ): Promise<Record<string, unknown>> {
    const metadata = await this.metadata();
    const response = asRecord(
      await this.runner(
        this.pythonCommand,
        { action, ...payload },
        this.timeoutMs,
      ),
      context,
    );
    const semaVersion = requiredString(response, "sema_version", context);
    if (semaVersion !== metadata.semaVersion) {
      throw new SemaPythonBridgeError(
        `Sema package version changed during the run: ${metadata.semaVersion} -> ${semaVersion}.`,
      );
    }
    return response;
  }
}
