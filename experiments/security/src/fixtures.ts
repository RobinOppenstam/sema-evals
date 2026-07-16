import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { fingerprint, sha256Text } from "@sema-evals/core";

import {
  cannedFindingsSchema,
  securityCaseSchema,
  type CannedFindings,
  type LoadedSecurityCase,
  type SecurityCase,
} from "./schemas.js";

export interface LoadedSecurityFixtures {
  /** Digest over the sorted catalog of case.json + both .sol sources. */
  fixtureDigest: string;
  cases: LoadedSecurityCase[];
  trainCaseCount: number;
  heldoutCaseCount: number;
}

/**
 * Loads every case under `casesDirectory` (`<id>/case.json` + Solidity pair).
 * Validates each case.json against the published zod schema and enforces the
 * 5-train / 4-heldout split with every vulnerability class present in both.
 */
export async function loadCases(
  casesDirectory: string,
): Promise<LoadedSecurityFixtures> {
  const entries = await readdir(casesDirectory, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const cases: LoadedSecurityCase[] = [];
  const digestParts: string[] = [];

  for (const name of directories) {
    const directory = join(casesDirectory, name);
    const caseRaw = await readFile(join(directory, "case.json"), "utf8");
    const meta = securityCaseSchema.parse(JSON.parse(caseRaw));
    if (meta.id !== name) {
      throw new Error(
        `Case directory "${name}" does not match case.json id "${meta.id}".`,
      );
    }
    const vulnerableSource = await readFile(
      join(directory, "vulnerable.sol"),
      "utf8",
    );
    const patchedSource = await readFile(
      join(directory, "patched.sol"),
      "utf8",
    );
    assertMutationIntegrity(meta, vulnerableSource, patchedSource);
    cases.push({ meta, vulnerableSource, patchedSource, directory });
    digestParts.push(caseRaw, vulnerableSource, patchedSource);
  }

  if (cases.length !== 9) {
    throw new Error(`Expected 9 security cases, found ${cases.length}.`);
  }

  const trainCases = cases.filter((entry) => entry.meta.split === "train");
  const heldoutCases = cases.filter((entry) => entry.meta.split === "heldout");
  if (trainCases.length !== 5 || heldoutCases.length !== 4) {
    throw new Error(
      `Expected 5 train / 4 heldout cases, found ${trainCases.length}/${heldoutCases.length}.`,
    );
  }

  assertClassCoverage(
    trainCases.map((entry) => entry.meta),
    "train",
  );
  assertClassCoverage(
    heldoutCases.map((entry) => entry.meta),
    "heldout",
  );

  const ids = new Set(cases.map((entry) => entry.meta.id));
  if (ids.size !== cases.length) {
    throw new Error("Duplicate security case ids.");
  }

  return {
    fixtureDigest: sha256Text(digestParts.join("\n")),
    cases,
    trainCaseCount: trainCases.length,
    heldoutCaseCount: heldoutCases.length,
  };
}

function assertClassCoverage(
  cases: readonly SecurityCase[],
  split: string,
): void {
  const classes = new Set(cases.map((entry) => entry.class));
  for (const required of [
    "reentrancy",
    "access-control",
    "unchecked-external-call",
  ] as const) {
    if (!classes.has(required)) {
      throw new Error(
        `Split "${split}" is missing vulnerability class "${required}".`,
      );
    }
  }
}

/**
 * Confirms vulnerable vs patched differ exactly per the mutation snippets:
 * each real-code snippet appears in its designated variant and not the other,
 * and the two sources are not byte-identical.
 */
export function assertMutationIntegrity(
  meta: SecurityCase,
  vulnerableSource: string,
  patchedSource: string,
): void {
  if (vulnerableSource === patchedSource) {
    throw new Error(
      `Case ${meta.id}: vulnerable.sol and patched.sol are identical.`,
    );
  }
  if (!vulnerableSource.includes(meta.mutation.vulnerableSnippet)) {
    throw new Error(
      `Case ${meta.id}: vulnerable.sol missing vulnerableSnippet.`,
    );
  }
  if (patchedSource.includes(meta.mutation.vulnerableSnippet)) {
    throw new Error(
      `Case ${meta.id}: patched.sol still contains vulnerableSnippet.`,
    );
  }
  if (!patchedSource.includes(meta.mutation.patchedSnippet)) {
    throw new Error(`Case ${meta.id}: patched.sol missing patchedSnippet.`);
  }
  if (vulnerableSource.includes(meta.mutation.patchedSnippet)) {
    throw new Error(
      `Case ${meta.id}: vulnerable.sol still contains patchedSnippet.`,
    );
  }
  if (!vulnerableSource.includes("pragma solidity ^0.8")) {
    throw new Error(
      `Case ${meta.id}: vulnerable.sol missing solidity ^0.8 pragma.`,
    );
  }
  if (!patchedSource.includes("pragma solidity ^0.8")) {
    throw new Error(
      `Case ${meta.id}: patched.sol missing solidity ^0.8 pragma.`,
    );
  }
}

export async function loadCannedFindings(
  path: string,
): Promise<CannedFindings> {
  const raw = await readFile(path, "utf8");
  return cannedFindingsSchema.parse(JSON.parse(raw));
}

export function cannedKey(caseId: string, condition: string): string {
  return `${caseId}::${condition}`;
}

/** Stable definition object for a Pattern Card (reference-provider input). */
export function cardDefinition(card: {
  handle: string;
  class: string;
  title: string;
  description: string;
  checklist: readonly string[];
}): Record<string, unknown> {
  return {
    handle: card.handle,
    class: card.class,
    title: card.title,
    description: card.description,
    checklist: [...card.checklist],
  };
}

export function cardDefinitionDigest(
  card: Parameters<typeof cardDefinition>[0],
): string {
  return fingerprint(cardDefinition(card));
}
