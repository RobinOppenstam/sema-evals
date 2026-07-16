import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Optional Foundry integration. CI never requires Foundry: when `forge` is
 * absent (or `--with-foundry` is not set), every Foundry helper is a no-op.
 */

export interface FoundryStatus {
  requested: boolean;
  available: boolean;
  binary: string | null;
  reason: string;
}

/** Resolves FOUNDRY_BIN or a `forge` on PATH. Does not throw when missing. */
export async function detectFoundry(
  requested: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FoundryStatus> {
  if (!requested) {
    return {
      requested: false,
      available: false,
      binary: null,
      reason: "not-requested",
    };
  }

  const configured = env.FOUNDRY_BIN?.trim();
  if (configured) {
    try {
      await access(configured, constants.X_OK);
      return {
        requested: true,
        available: true,
        binary: configured,
        reason: "FOUNDRY_BIN",
      };
    } catch {
      return {
        requested: true,
        available: false,
        binary: null,
        reason: `FOUNDRY_BIN not executable: ${configured}`,
      };
    }
  }

  try {
    const { stdout } = await execFileAsync("which", ["forge"], {
      encoding: "utf8",
    });
    const binary = stdout.trim();
    if (binary.length > 0) {
      return {
        requested: true,
        available: true,
        binary,
        reason: "path-forge",
      };
    }
  } catch {
    // fall through
  }

  return {
    requested: true,
    available: false,
    binary: null,
    reason: "forge-not-found",
  };
}

/**
 * Runs a Foundry PoC test directory when available. Returns a structured
 * skipped/failed/passed result and never throws solely because Foundry is
 * missing — callers treat skipped as success for CI.
 */
export async function runFoundryPoC(
  status: FoundryStatus,
  testDirectory: string,
): Promise<{ status: "skipped" | "passed" | "failed"; detail: string }> {
  if (!status.requested) {
    return { status: "skipped", detail: "with-foundry not set" };
  }
  if (!status.available || !status.binary) {
    return { status: "skipped", detail: status.reason };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      status.binary,
      ["test", "--match-path", join(testDirectory, "*.t.sol")],
      { encoding: "utf8", cwd: testDirectory },
    );
    return {
      status: "passed",
      detail: `${stdout}\n${stderr}`.trim(),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "failed", detail };
  }
}

/** Synchronous PATH probe used by unit tests (no spawn). */
export function foundryBinFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env.FOUNDRY_BIN?.trim();
  if (!configured) {
    return null;
  }
  try {
    accessSync(configured, constants.X_OK);
    return configured;
  } catch {
    return null;
  }
}
