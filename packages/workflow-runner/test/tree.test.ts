import { link, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  copyTreeExact,
  digestTree,
  validateFinalTreeSafety,
  validateWriteRoots,
} from "../src/tree.js";

describe("workflow tree controls", () => {
  test("materializes and resets a snapshot byte-identically", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-tree-"));
    const source = join(root, "source");
    const copy = join(root, "copy");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(
      join(source, "src", "value.ts"),
      "export const value = 1;\n",
    );
    const expected = await digestTree(source);
    await copyTreeExact(source, copy);
    expect(await digestTree(copy)).toBe(expected);
    await writeFile(join(copy, "src", "value.ts"), "changed\n");
    await copyTreeExact(source, copy);
    expect(await digestTree(copy)).toBe(expected);
  });

  test("rejects pre-existing symlink and hardlink write roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-links-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "outside"), "secret");
    await symlink("../outside", join(root, "src", "linked"));
    await expect(validateWriteRoots(root, ["src/linked"], [])).rejects.toThrow(
      /symbolic link/,
    );
    await writeFile(join(root, "src", "original"), "same");
    await link(join(root, "src", "original"), join(root, "src", "hard"));
    await expect(validateWriteRoots(root, ["src/hard"], [])).rejects.toThrow(
      /hard-linked/,
    );
  });

  test("rejects symlinks and hardlinks created inside writable roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-final-links-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "outside"), "secret");
    await symlink("../outside", join(root, "src", "new-link"));
    await expect(validateFinalTreeSafety(root, ["src"])).rejects.toThrow(
      /post-run symbolic link/,
    );
    await writeFile(join(root, "src", "one"), "same");
    await link(join(root, "src", "one"), join(root, "src", "two"));
    await expect(validateFinalTreeSafety(root, ["src"])).rejects.toThrow(
      /post-run/,
    );
  });
});
