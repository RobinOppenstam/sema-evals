// -------------------------------------------------------------------------
// Preregistration parsing and freeze verification.
//
// A confirmatory run (preregistration 001) is only valid if the artifacts it
// executes are byte-identical to the ones pinned at registration. This module
// parses the registration pins out of the markdown document (§7 digests and
// scorer version, §4 order seed) and compares them against what the harness
// actually loaded, refusing to start on any mismatch — before any model call.
// -------------------------------------------------------------------------

import { readFile } from "node:fs/promises";

import { sha256Text } from "@sema-evals/core";

/** The registration pins parsed out of a preregistration document. */
export interface PreregistrationPins {
  fixtureDigest: string;
  promptDigest: string;
  scorerVersion: string;
  orderSeed: number;
}

/** A loaded preregistration: its pins plus the digest of the document itself. */
export interface LoadedPreregistration extends PreregistrationPins {
  /** SHA-256 of the raw markdown, recorded in bundle provenance. */
  documentDigest: string;
}

/** Raised when a preregistration cannot be parsed or a freeze check fails. */
export class PreregistrationError extends Error {
  public override readonly name = "PreregistrationError";
}

const SHA256 = /[a-f0-9]{64}/;

function requireHex(markdown: string, label: string, pattern: RegExp): string {
  const match = pattern.exec(markdown);
  if (!match?.[1]) {
    throw new PreregistrationError(
      `Preregistration is missing a ${label} (expected a backtick-quoted 64-character hex value).`,
    );
  }
  return match[1];
}

/**
 * Parses the §7 registration pins and the §4 order seed from a preregistration
 * markdown body. Tolerant of surrounding formatting: it looks for the labelled
 * fields ("Fixture digest", "Prompt digest", "Scorer version") followed by a
 * backtick-quoted value, and the "order seed **NNNNNNNN**" phrasing.
 */
export function parsePreregistration(markdown: string): PreregistrationPins {
  const fixtureDigest = requireHex(
    markdown,
    "fixture digest",
    new RegExp(`Fixture digest[^\`]*\`(${SHA256.source})\``, "i"),
  );
  const promptDigest = requireHex(
    markdown,
    "prompt digest",
    new RegExp(`Prompt digest[^\`]*\`(${SHA256.source})\``, "i"),
  );

  const scorerMatch = /Scorer version[^`]*`([^`]+)`/i.exec(markdown);
  if (!scorerMatch?.[1]) {
    throw new PreregistrationError(
      "Preregistration is missing a scorer version (expected a backtick-quoted `Scorer version`).",
    );
  }
  const scorerVersion = scorerMatch[1].trim();

  const seedMatch = /order seed\s+\*\*(\d+)\*\*/i.exec(markdown);
  if (!seedMatch?.[1]) {
    throw new PreregistrationError(
      "Preregistration is missing an order seed (expected `order seed **NNNNNNNN**`).",
    );
  }
  const orderSeed = Number(seedMatch[1]);
  if (!Number.isSafeInteger(orderSeed)) {
    throw new PreregistrationError(
      `Preregistration order seed "${seedMatch[1]}" is not a valid integer.`,
    );
  }

  return { fixtureDigest, promptDigest, scorerVersion, orderSeed };
}

/**
 * Reads a preregistration file, computes its document digest, and parses its
 * pins. The document digest is over the raw bytes, exactly as recorded in
 * provenance.
 */
export async function loadPreregistration(
  path: string,
): Promise<LoadedPreregistration> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PreregistrationError(
      `Could not read preregistration ${path}: ${reason}`,
    );
  }
  return {
    ...parsePreregistration(raw),
    documentDigest: sha256Text(raw),
  };
}

/** What the harness actually loaded / resolved for this run. */
export interface FreezeState {
  fixtureDigest: string;
  promptDigest: string;
  scorerVersion: string;
  orderSeed: number;
  /** Resolved implementation commit; a `+dirty` suffix marks an unclean tree. */
  implementationCommit: string;
}

/**
 * Compares the harness's freeze state against the preregistration pins and
 * refuses to proceed on any mismatch, naming each one. A `+dirty` commit is a
 * mismatch on its own: preregistration 001 §7 disqualifies any run from an
 * unclean tree. Throws {@link PreregistrationError} listing every failure, or
 * returns silently when the freeze holds.
 */
export function verifyFreeze(
  pins: PreregistrationPins,
  state: FreezeState,
): void {
  const mismatches: string[] = [];

  if (state.fixtureDigest !== pins.fixtureDigest) {
    mismatches.push(
      `fixture digest: registered ${pins.fixtureDigest}, loaded ${state.fixtureDigest}`,
    );
  }
  if (state.promptDigest !== pins.promptDigest) {
    mismatches.push(
      `prompt digest: registered ${pins.promptDigest}, loaded ${state.promptDigest}`,
    );
  }
  if (state.scorerVersion !== pins.scorerVersion) {
    mismatches.push(
      `scorer version: registered "${pins.scorerVersion}", built "${state.scorerVersion}"`,
    );
  }
  if (state.orderSeed !== pins.orderSeed) {
    mismatches.push(
      `order seed: registered ${pins.orderSeed}, requested ${state.orderSeed}`,
    );
  }
  if (state.implementationCommit.includes("+dirty")) {
    mismatches.push(
      `working tree is dirty (${state.implementationCommit}); a confirmatory run must execute from a clean tree`,
    );
  }

  if (mismatches.length > 0) {
    throw new PreregistrationError(
      `Preregistration freeze check failed; refusing to start a confirmatory run:\n` +
        mismatches.map((line) => `  - ${line}`).join("\n"),
    );
  }
}
