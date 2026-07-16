import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PatternCard, PatternCardSet, SecurityCase } from "./schemas.js";
import { patternCardSetSchema } from "./schemas.js";

/**
 * Collects identifiers that appear ONLY on heldout cases — contract names,
 * function names, and variable names listed in case.json that are not also
 * declared on any train case. Pattern Cards must not contain these strings.
 */
export function heldoutUniqueIdentifiers(
  cases: readonly SecurityCase[],
): string[] {
  const train = new Set<string>();
  const heldout = new Set<string>();

  for (const entry of cases) {
    const bucket = entry.split === "train" ? train : heldout;
    bucket.add(entry.identifiers.contractName);
    for (const name of entry.identifiers.functions) {
      bucket.add(name);
    }
    for (const name of entry.identifiers.variables) {
      bucket.add(name);
    }
  }

  return [...heldout].filter((name) => !train.has(name)).sort();
}

export interface LeakageHit {
  cardHandle: string;
  identifier: string;
}

export interface LeakageReport {
  clean: boolean;
  heldoutIdentifiers: string[];
  hits: LeakageHit[];
}

/**
 * Fails (returns clean=false) when any heldout-unique identifier appears as a
 * whole-word token in any Pattern Card's title, description, or checklist.
 * Case-insensitive. This is the enforced train/heldout separation invariant.
 */
export function checkCardLeakage(
  cards: readonly PatternCard[],
  cases: readonly SecurityCase[],
): LeakageReport {
  const heldoutIdentifiers = heldoutUniqueIdentifiers(cases);
  const hits: LeakageHit[] = [];

  for (const card of cards) {
    const corpus = [card.title, card.description, ...card.checklist].join("\n");
    for (const identifier of heldoutIdentifiers) {
      const pattern = new RegExp(
        `(^|[^A-Za-z0-9_])${escapeRegex(identifier)}([^A-Za-z0-9_]|$)`,
        "i",
      );
      if (pattern.test(corpus)) {
        hits.push({ cardHandle: card.handle, identifier });
      }
    }
  }

  return {
    clean: hits.length === 0,
    heldoutIdentifiers,
    hits,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Asserts the leakage invariant; throws with a precise message on failure. */
export function assertNoCardLeakage(
  cards: readonly PatternCard[],
  cases: readonly SecurityCase[],
): void {
  const report = checkCardLeakage(cards, cases);
  if (!report.clean) {
    const detail = report.hits
      .map((hit) => `${hit.cardHandle}<-${hit.identifier}`)
      .join(", ");
    throw new Error(
      `Pattern Card leakage: heldout identifiers appear in cards: ${detail}`,
    );
  }
}

export async function loadPatternCards(
  vocabularyDirectory: string,
): Promise<PatternCardSet> {
  const indexPath = join(vocabularyDirectory, "cards.json");
  const raw = await readFile(indexPath, "utf8");
  return patternCardSetSchema.parse(JSON.parse(raw));
}

/** Lists .json card files excluding the set index; useful for diagnostics. */
export async function listCardFiles(
  vocabularyDirectory: string,
): Promise<string[]> {
  const entries = await readdir(vocabularyDirectory);
  return entries.filter((name) => name.endsWith(".json")).sort();
}
