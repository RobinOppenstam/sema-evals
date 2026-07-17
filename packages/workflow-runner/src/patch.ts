import { relative } from "node:path";

import { runProcess } from "./process.js";
import { changedPaths, sha256, treeEntries } from "./tree.js";

export interface GeneratedPatch {
  text: string;
  digest: string;
  changedPaths: string[];
}

export async function generateTreePatch(
  beforeRoot: string,
  afterRoot: string,
): Promise<GeneratedPatch> {
  const paths = await changedPaths(beforeRoot, afterRoot);
  const gitDiff = await runProcess(
    "git",
    [
      "diff",
      "--no-index",
      "--binary",
      "--no-ext-diff",
      "--",
      beforeRoot,
      afterRoot,
    ],
    { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 },
  );
  let text: string;
  if (
    !gitDiff.timedOut &&
    !gitDiff.outputOverflow &&
    (gitDiff.exitCode === 0 || gitDiff.exitCode === 1)
  ) {
    text = gitDiff.stdout
      .replaceAll(beforeRoot, "a")
      .replaceAll(afterRoot, "b");
  } else {
    const before = await treeEntries(beforeRoot);
    const after = await treeEntries(afterRoot);
    text = `${JSON.stringify(
      {
        format: "sema-tree-patch-v1",
        beforeRoot: relative(process.cwd(), beforeRoot),
        afterRoot: relative(process.cwd(), afterRoot),
        changedPaths: paths,
        before,
        after,
        gitDiffFailure: {
          exitCode: gitDiff.exitCode,
          timedOut: gitDiff.timedOut,
          outputOverflow: gitDiff.outputOverflow,
          stderrDigest: gitDiff.stderrDigest,
        },
      },
      null,
      2,
    )}\n`;
  }
  return { text, digest: sha256(text), changedPaths: paths };
}
