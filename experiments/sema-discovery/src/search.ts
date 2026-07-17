import { fingerprint } from "@sema-evals/core";

import type { DiscoveryPattern } from "./schemas.js";

export const SEARCH_PARAMETERS = {
  version: "lexical-search-v1",
  minimumScore: 1,
  maxResults: 3,
  queryFields: ["task-request"],
  patternFields: ["handle", "title", "purpose", "tags"],
  ordering: "score-desc-handle-asc",
} as const;

export const RANKER_FINGERPRINT = fingerprint(SEARCH_PARAMETERS);

export interface SearchCandidate {
  handle: string;
  score: number;
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase("en-US")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0),
  );
}

export function rankPatterns(
  query: string,
  catalog: readonly DiscoveryPattern[],
): SearchCandidate[] {
  const queryTokens = tokenize(query);
  return catalog
    .map((pattern) => {
      const patternTokens = tokenize(
        [
          pattern.handle,
          pattern.title,
          pattern.purpose,
          pattern.tags.join(" "),
        ].join(" "),
      );
      const score = [...queryTokens].filter((token) =>
        patternTokens.has(token),
      ).length;
      return { handle: pattern.handle, score };
    })
    .filter((candidate) => candidate.score >= SEARCH_PARAMETERS.minimumScore)
    .sort(
      (left, right) =>
        right.score - left.score || left.handle.localeCompare(right.handle),
    )
    .slice(0, SEARCH_PARAMETERS.maxResults);
}
