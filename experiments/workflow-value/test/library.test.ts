import { describe, expect, test } from "vitest";

import {
  loadFrozenWorkflowLibrary,
  renderEqualProseContent,
  renderResolvedReferenceContent,
} from "../src/library.js";

describe("frozen workflow library", () => {
  test("keeps equal-prose and resolved reference content byte-identical", async () => {
    const library = await loadFrozenWorkflowLibrary();
    expect(renderEqualProseContent(library)).toBe(
      renderResolvedReferenceContent(library),
    );
    expect(library.libraryRoot).toMatch(/^[a-f0-9]{64}$/);
  });

  test("contains no sacrificial task or repository identifiers", async () => {
    const library = await loadFrozenWorkflowLibrary();
    const text = library.resolvedContent.toLowerCase();
    for (const forbidden of [
      "p-limit",
      "p-map",
      "qs-",
      "sindresorhus",
      "ljharb",
      "arraylimit",
      "allowemptyarrays",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
