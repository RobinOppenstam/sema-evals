import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { fingerprint } from "@sema-evals/core";

interface TreeEntry {
  path: string;
  kind: "directory" | "file" | "symlink";
  mode: number;
  digest: string | null;
  target: string | null;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRelativePath(path: string): string {
  return path.split(sep).join("/");
}

export function assertRelativeWorkspacePath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path === "." ||
    path.split(/[\\/]/).some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Unsafe workspace path: ${path}`);
  }
  return normalizedRelativePath(path);
}

async function collectEntries(
  root: string,
  directory: string,
  entries: TreeEntry[],
): Promise<void> {
  const children = await readdir(directory);
  children.sort((left, right) => left.localeCompare(right));
  for (const child of children) {
    const absolute = resolve(directory, child);
    const path = normalizedRelativePath(relative(root, absolute));
    const metadata = await lstat(absolute);
    const mode = metadata.mode & 0o777;
    if (metadata.isDirectory()) {
      entries.push({
        path,
        kind: "directory",
        mode,
        digest: null,
        target: null,
      });
      await collectEntries(root, absolute, entries);
      continue;
    }
    if (metadata.isFile()) {
      entries.push({
        path,
        kind: "file",
        mode,
        digest: sha256(await readFile(absolute)),
        target: null,
      });
      continue;
    }
    if (metadata.isSymbolicLink()) {
      entries.push({
        path,
        kind: "symlink",
        mode,
        digest: null,
        target: await readlink(absolute),
      });
      continue;
    }
    throw new Error(`Snapshot contains unsupported special file: ${path}`);
  }
}

export async function treeEntries(root: string): Promise<TreeEntry[]> {
  const resolvedRoot = await realpath(root);
  const entries: TreeEntry[] = [];
  await collectEntries(resolvedRoot, resolvedRoot, entries);
  return entries;
}

export async function digestTree(root: string): Promise<string> {
  return sha256(JSON.stringify(await treeEntries(root)));
}

export async function digestCorpusCompatibleTree(
  root: string,
): Promise<string> {
  const entries = await treeEntries(root);
  return fingerprint(
    entries.map((entry) => {
      if (entry.kind === "symlink") {
        throw new Error(
          `Corpus-compatible evidence may not contain symlinks: ${entry.path}`,
        );
      }
      return {
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        digest: entry.digest,
      };
    }),
  );
}

export async function copyTreeExact(
  source: string,
  destination: string,
): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

async function assertNoSymlinkTraversal(
  root: string,
  relativePath: string,
): Promise<void> {
  const parts = assertRelativeWorkspacePath(relativePath).split("/");
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Allowed path traverses symbolic link: ${relativePath}`,
        );
      }
      if (!metadata.isDirectory() && !metadata.isFile()) {
        throw new Error(`Allowed path contains special file: ${relativePath}`);
      }
      if (metadata.isFile() && metadata.nlink > 1) {
        throw new Error(
          `Allowed path contains a hard-linked file: ${relativePath}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

export async function validateWriteRoots(
  snapshotRoot: string,
  allowedPaths: readonly string[],
  prohibitedPaths: readonly string[],
): Promise<void> {
  const root = await realpath(snapshotRoot);
  const normalizedAllowed = allowedPaths.map(assertRelativeWorkspacePath);
  const normalizedProhibited = prohibitedPaths.map(assertRelativeWorkspacePath);
  for (const path of normalizedAllowed) {
    await assertNoSymlinkTraversal(root, path);
    for (const prohibited of normalizedProhibited) {
      if (
        path === prohibited ||
        path.startsWith(`${prohibited}/`) ||
        prohibited.startsWith(`${path}/`)
      ) {
        throw new Error(
          `Allowed path overlaps prohibited path: ${path} / ${prohibited}`,
        );
      }
    }
    const candidate = resolve(root, path);
    const rel = relative(root, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Allowed path escapes snapshot: ${path}`);
    }
  }
}

export async function validateFinalTreeSafety(
  workspaceRoot: string,
  allowedPaths: readonly string[],
): Promise<void> {
  const allowed = allowedPaths.map(assertRelativeWorkspacePath);
  const entries = await treeEntries(workspaceRoot);
  for (const entry of entries) {
    if (
      !allowed.some(
        (root) => entry.path === root || entry.path.startsWith(`${root}/`),
      )
    ) {
      continue;
    }
    if (entry.kind === "symlink") {
      throw new Error(
        `Writable path contains a post-run symbolic link: ${entry.path}`,
      );
    }
    if (entry.kind === "file") {
      const metadata = await lstat(resolve(workspaceRoot, entry.path));
      if (metadata.nlink > 1) {
        throw new Error(
          `Writable path contains a post-run hard-linked file: ${entry.path}`,
        );
      }
    }
  }
}

export async function changedPaths(
  beforeRoot: string,
  afterRoot: string,
): Promise<string[]> {
  const before = new Map(
    (await treeEntries(beforeRoot)).map((entry) => [entry.path, entry]),
  );
  const after = new Map(
    (await treeEntries(afterRoot)).map((entry) => [entry.path, entry]),
  );
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter(
      (path) =>
        JSON.stringify(before.get(path) ?? null) !==
        JSON.stringify(after.get(path) ?? null),
    )
    .sort();
}

export function unauthorizedChanges(
  paths: readonly string[],
  allowedPaths: readonly string[],
): string[] {
  const allowed = allowedPaths.map(assertRelativeWorkspacePath);
  return paths.filter(
    (path) =>
      !allowed.some(
        (root) =>
          path === root || path.startsWith(`${root.replace(/\/$/, "")}/`),
      ),
  );
}

export async function assertSnapshotDigest(
  directory: string,
  expectedDigest: string,
): Promise<void> {
  const metadata = await stat(directory);
  if (!metadata.isDirectory()) {
    throw new Error(`Snapshot is not a directory: ${directory}`);
  }
  const actual = await digestTree(directory);
  const corpusCompatible = await digestCorpusCompatibleTree(directory);
  if (actual !== expectedDigest && corpusCompatible !== expectedDigest) {
    throw new Error(
      `Snapshot digest mismatch: expected ${expectedDigest}, received runner=${actual}, corpus=${corpusCompatible}`,
    );
  }
}
