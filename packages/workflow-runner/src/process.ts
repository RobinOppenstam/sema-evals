import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputOverflow: boolean;
  stdoutDigest: string;
  stderrDigest: string;
  durationMs: number;
}

export interface FileProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  outputOverflow: boolean;
  outputBytes: number;
  outputDigest: string;
  stderrDigest: string;
  durationMs: number;
}

export async function runProcess(
  binary: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    timeoutMs: number;
    maxOutputBytes?: number;
  },
): Promise<ProcessResult> {
  const started = performance.now();
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let outputOverflow = false;
    let timedOut = false;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const capture = (
      target: Buffer[],
      hash: ReturnType<typeof createHash>,
      chunk: Buffer,
    ): void => {
      hash.update(chunk);
      const capturedBytes =
        stdout.reduce((sum, item) => sum + item.length, 0) +
        stderr.reduce((sum, item) => sum + item.length, 0);
      if (capturedBytes >= maxOutputBytes) {
        outputOverflow = true;
        return;
      }
      const remaining = maxOutputBytes - capturedBytes;
      if (chunk.length > remaining) {
        target.push(chunk.subarray(0, remaining));
        outputOverflow = true;
      } else {
        target.push(chunk);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) =>
      capture(stdout, stdoutHash, chunk),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      capture(stderr, stderrHash, chunk),
    );
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode, signal) =>
      finish(() =>
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
          outputOverflow,
          stdoutDigest: stdoutHash.digest("hex"),
          stderrDigest: stderrHash.digest("hex"),
          durationMs: performance.now() - started,
        }),
      ),
    );
  });
}

export async function runProcessToFile(
  binary: string,
  args: readonly string[],
  outputPath: string,
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
    maxStderrBytes?: number;
  },
): Promise<FileProcessResult> {
  const started = performance.now();
  const maxStderrBytes = options.maxStderrBytes ?? 128 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const output = createWriteStream(outputPath, { flags: "wx" });
    const outputHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let outputBytes = 0;
    let outputOverflow = false;
    let timedOut = false;
    let settled = false;
    const killGroup = (): void => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall through to the direct child.
        }
      }
      child.kill("SIGKILL");
    };
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      outputHash.update(chunk);
      if (outputBytes > options.maxOutputBytes) {
        outputOverflow = true;
        killGroup();
        return;
      }
      if (!output.write(chunk)) {
        child.stdout.pause();
        output.once("drain", () => child.stdout.resume());
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrHash.update(chunk);
      if (stderrBytes >= maxStderrBytes) {
        return;
      }
      const remaining = maxStderrBytes - stderrBytes;
      const captured =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr.push(captured);
      stderrBytes += captured.length;
    });
    child.on("error", (error) =>
      finish(() => {
        output.destroy();
        reject(error);
      }),
    );
    child.on("close", (exitCode, signal) => {
      output.end(() =>
        finish(() =>
          resolve({
            exitCode,
            signal,
            stderr: Buffer.concat(stderr).toString("utf8"),
            timedOut,
            outputOverflow,
            outputBytes,
            outputDigest: outputHash.digest("hex"),
            stderrDigest: stderrHash.digest("hex"),
            durationMs: performance.now() - started,
          }),
        ),
      );
    });
  });
}
