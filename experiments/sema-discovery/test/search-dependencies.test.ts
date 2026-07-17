import { describe, expect, it } from "vitest";

import { resolveDependencyClosure } from "../src/dependencies.js";
import { rankPatterns } from "../src/search.js";
import type { DiscoveryPattern } from "../src/schemas.js";

function pattern(
  handle: string,
  title: string,
  dependencies: string[] = [],
): DiscoveryPattern {
  return {
    handle,
    title,
    purpose: title,
    tags: title.toLowerCase().split(" "),
    dependencies,
    steps: [handle],
  };
}

describe("frozen lexical search", () => {
  it("is independent of catalog order and breaks score ties by handle", () => {
    const catalog = [
      pattern("BetaRelease", "service release"),
      pattern("AlphaRelease", "service release"),
      pattern("IncidentTriage", "service incident"),
    ];
    const forward = rankPatterns("service release", catalog);
    const reversed = rankPatterns("service release", [...catalog].reverse());
    expect(forward).toEqual(reversed);
    expect(forward.slice(0, 2).map((entry) => entry.handle)).toEqual([
      "AlphaRelease",
      "BetaRelease",
    ]);
  });
});

describe("dependency resolution", () => {
  it("returns dependencies before the root exactly once", () => {
    const catalog = [
      pattern("Root", "root", ["Beta", "Alpha"]),
      pattern("Alpha", "alpha", ["Shared"]),
      pattern("Beta", "beta", ["Shared"]),
      pattern("Shared", "shared"),
    ];
    expect(
      resolveDependencyClosure("Root", catalog).orderedPatterns.map(
        (entry) => entry.handle,
      ),
    ).toEqual(["Shared", "Alpha", "Beta", "Root"]);
  });

  it("fails closed on missing dependencies and cycles", () => {
    expect(
      resolveDependencyClosure("Root", [pattern("Root", "root", ["Missing"])]),
    ).toMatchObject({ status: "missing", missingHandles: ["Missing"] });
    expect(
      resolveDependencyClosure("Root", [
        pattern("Root", "root", ["Child"]),
        pattern("Child", "child", ["Root"]),
      ]),
    ).toMatchObject({ status: "cycle", orderedPatterns: [] });
  });
});
