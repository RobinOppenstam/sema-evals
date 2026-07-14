import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { fingerprint, sha256Text } from "./fingerprint.js";

const HEX_SHA256 = /^[a-f0-9]{64}$/;

export const promptManifestEntrySchema = z.object({
  file: z.string().min(1),
  sha256: z.string().regex(HEX_SHA256),
});

export const promptManifestSchema = z.object({
  snapshotVersion: z.string().min(1),
  prompts: z.record(z.string().min(1), promptManifestEntrySchema),
});

export type PromptManifest = z.infer<typeof promptManifestSchema>;

export interface LoadedPrompt {
  key: string;
  file: string;
  digest: string;
  content: string;
}

export interface PromptSnapshot {
  snapshotVersion: string;
  prompts: Record<string, LoadedPrompt>;
  promptDigest: string;
}

/**
 * Raised whenever a prompt snapshot cannot be loaded. A digest mismatch is a
 * fail-closed error: a drifted prompt must never run silently.
 */
export class PromptSnapshotError extends Error {
  public override readonly name = "PromptSnapshotError";
}

/**
 * Reads a frozen prompt snapshot, recomputes each file's SHA-256, and refuses
 * to load if any digest disagrees with the manifest. The combined
 * `promptDigest` is a 64-character SHA-256 suitable for
 * `trialProvenanceSchema.promptDigest`.
 */
export async function loadPromptSnapshot(
  directory: string,
): Promise<PromptSnapshot> {
  const manifestPath = join(directory, "manifest.json");

  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PromptSnapshotError(
      `Could not read prompt manifest ${manifestPath}: ${reason}`,
    );
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PromptSnapshotError(
      `Prompt manifest ${manifestPath} is not valid JSON: ${reason}`,
    );
  }

  const parsed = promptManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new PromptSnapshotError(
      `Prompt manifest ${manifestPath} is malformed: ${parsed.error.message}`,
    );
  }
  const manifest = parsed.data;

  const entries = Object.entries(manifest.prompts).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) {
    throw new PromptSnapshotError(
      `Prompt manifest ${manifestPath} lists no prompts.`,
    );
  }

  const prompts: Record<string, LoadedPrompt> = {};
  const digestByKey: Record<string, string> = {};
  for (const [key, entry] of entries) {
    const filePath = join(directory, entry.file);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PromptSnapshotError(
        `Could not read prompt ${key} at ${filePath}: ${reason}`,
      );
    }

    const digest = sha256Text(content);
    if (digest !== entry.sha256) {
      throw new PromptSnapshotError(
        `Prompt ${key} (${entry.file}) digest ${digest} does not match manifest ${entry.sha256}; refusing to load a drifted prompt.`,
      );
    }

    prompts[key] = { key, file: entry.file, digest, content };
    digestByKey[key] = digest;
  }

  const promptDigest = fingerprint({
    snapshotVersion: manifest.snapshotVersion,
    prompts: digestByKey,
  });

  return { snapshotVersion: manifest.snapshotVersion, prompts, promptDigest };
}
