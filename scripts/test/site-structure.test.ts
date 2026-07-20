// -------------------------------------------------------------------------
// Site-structure integration tests
//
// These build the real site (from the committed public derivatives) into a temp
// directory and assert the multi-page URL structure, the navbar, the legacy
// redirect stubs, the overview cards, and — the load-bearing guard against
// future breakage — that every internal href resolves to a file on disk.
// -------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSite, type BuildResult } from "../build-site.js";

let outputRoot: string;
let result: BuildResult;

beforeAll(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "sema-site-"));
  result = await buildSite({ outputRoot });
});

afterAll(async () => {
  await rm(outputRoot, { recursive: true, force: true });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `root`, as POSIX-relative paths. */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recur(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await recur(full);
      } else {
        out.push(relative(root, full).split("\\").join("/"));
      }
    }
  }
  await recur(root);
  return out.sort();
}

/** Internal link targets in a page: every href plus any meta-refresh url. */
function internalTargets(html: string): string[] {
  const targets: string[] = [];
  for (const match of html.matchAll(/href="([^"]*)"/g)) {
    if (match[1] !== undefined) {
      targets.push(match[1]);
    }
  }
  for (const match of html.matchAll(/content="\s*\d+;\s*url=([^"]*)"/g)) {
    if (match[1] !== undefined) {
      targets.push(match[1]);
    }
  }
  return targets.filter((value) => {
    if (value === "") {
      return false;
    }
    if (value.startsWith("#")) {
      return false;
    }
    return !/^(?:https?:|mailto:|data:)/.test(value);
  });
}

async function readOutput(relPath: string): Promise<string> {
  return readFile(join(outputRoot, relPath), "utf8");
}

describe("site URL structure", () => {
  it("emits the overview, a page per experiment-with-runs, and moved run pages", () => {
    expect(result.experimentIds).toEqual([
      "babel-hook",
      "babel-relay",
      "codex-hook",
      "sema-tax",
    ]);
    expect(result.files).toContain("index.html");
    for (const experimentId of result.experimentIds) {
      expect(result.files).toContain(`${experimentId}/index.html`);
    }
    // Every run page now lives under its experiment's runs/ directory.
    for (const redirect of result.redirects) {
      expect(result.files).toContain(redirect.to);
    }
  });

  it("keeps each run's artifact files next to its run page", () => {
    for (const redirect of result.redirects) {
      const runDir = redirect.to.replace(/\.html$/, "");
      for (const file of [
        "manifest.json",
        "summary.json",
        "trials.public.jsonl",
      ]) {
        expect(result.files).toContain(`${runDir}/${file}`);
      }
    }
  });
});

describe("legacy redirect stubs", () => {
  it("writes a stub at every pre-existing run URL pointing at the new location", async () => {
    expect(result.redirects.length).toBe(result.runCount);
    for (const redirect of result.redirects) {
      // The stub sits at the old flat URL.
      expect(redirect.from).toBe(`runs/${redirect.to.split("/").pop()}`);
      expect(result.files).toContain(redirect.from);

      const stub = await readOutput(redirect.from);
      // Meta refresh + canonical + a visible fallback link, all pointing at the
      // new location (relative to the old /runs/ directory: ../<new path>).
      expect(stub).toContain(`content="0; url=../${redirect.to}"`);
      expect(stub).toContain('<link rel="canonical"');
      expect(stub).toContain(`href="../${redirect.to}"`);
    }
  });
});

describe("navbar", () => {
  it("marks Overview current on the overview page and lists every experiment-with-runs", async () => {
    const html = await readOutput("index.html");
    expect(html).toContain('<nav class="site-nav"');
    expect(html).toContain(
      '<a href="index.html" aria-current="page">Overview</a>',
    );
    for (const experimentId of result.experimentIds) {
      expect(html).toContain(
        `<a href="${experimentId}/index.html">${experimentId}</a>`,
      );
    }
  });

  it("marks the experiment current on its own page, not Overview", async () => {
    for (const experimentId of result.experimentIds) {
      const html = await readOutput(`${experimentId}/index.html`);
      expect(html).toContain(
        `<a href="../${experimentId}/index.html" aria-current="page">${experimentId}</a>`,
      );
      expect(html).toContain('<a href="../index.html">Overview</a>');
      expect(html).not.toContain(
        '<a href="../index.html" aria-current="page">Overview</a>',
      );
    }
  });

  it("marks the owning experiment current on a run page", async () => {
    const redirect = result.redirects[0];
    expect(redirect).toBeDefined();
    if (redirect === undefined) {
      return;
    }
    const experimentId = redirect.to.split("/")[0] ?? "";
    const html = await readOutput(redirect.to);
    expect(html).toContain('<nav class="site-nav"');
    expect(html).toContain(
      `<a href="../../${experimentId}/index.html" aria-current="page">${experimentId}</a>`,
    );
    expect(html).toContain('<a href="../../index.html">Overview</a>');
  });

  it("omits run-less experiments (e.g. a2a-drift) from the nav", async () => {
    const html = await readOutput("index.html");
    expect(html).not.toContain("a2a-drift");
    expect(result.experimentIds).not.toContain("a2a-drift");
  });
});

describe("overview cards", () => {
  it("shows the babel-relay headline stat and links to the experiment page", async () => {
    const html = await readOutput("index.html");
    expect(html).toContain(
      '<h2><a href="babel-relay/index.html">babel-relay</a></h2>',
    );
    expect(html).toContain("<code>addressed-enforced</code>");
    expect(html).toContain("silent divergence");
    expect(html).toContain("task success");
  });

  it("shows the sema-tax headline stat (best full-coverage score + score/1k range)", async () => {
    const html = await readOutput("index.html");
    expect(html).toContain(
      '<h2><a href="sema-tax/index.html">sema-tax</a></h2>',
    );
    expect(html).toContain("best full-coverage score");
    expect(html).toContain("score/1k tok");
  });
});

describe("internal link integrity", () => {
  it("resolves every internal href in the built site to a file on disk", async () => {
    const htmlFiles = (await walkFiles(outputRoot)).filter((file) =>
      file.endsWith(".html"),
    );
    const broken: string[] = [];
    for (const relPath of htmlFiles) {
      const absFile = join(outputRoot, relPath);
      const html = await readFile(absFile, "utf8");
      for (const target of internalTargets(html)) {
        const clean = (target.split("#")[0] ?? "").split("?")[0] ?? "";
        if (clean === "") {
          continue;
        }
        const resolved = resolve(dirname(absFile), clean);
        if (!(await pathExists(resolved))) {
          broken.push(`${relPath} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("deterministic build", () => {
  it("produces a byte-identical tree across two builds", async () => {
    const other = await mkdtemp(join(tmpdir(), "sema-site-2-"));
    try {
      await buildSite({ outputRoot: other });
      const digest = async (root: string): Promise<string> => {
        const files = await walkFiles(root);
        const hash = createHash("sha256");
        for (const file of files) {
          hash.update(file);
          hash.update(await readFile(join(root, file)));
        }
        return hash.digest("hex");
      };
      expect(await digest(other)).toBe(await digest(outputRoot));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
