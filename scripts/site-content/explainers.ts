// -------------------------------------------------------------------------
// Per-experiment explainer content
//
// Static, deterministic prose that frames what each experiment measures and how
// to read its result tables. Keyed by experimentId; an unknown id resolves to
// `undefined` and simply renders no explainer. This module holds copy only — no
// clock, no randomness, no I/O — so the site stays byte-identical across builds.
// -------------------------------------------------------------------------

/** A single condition of an experiment, paired with what it isolates. */
export interface ExplainerCondition {
  /** The condition slug as it appears in result tables (rendered in mono). */
  readonly term: string;
  /** One sentence on what the condition controls for or measures. */
  readonly description: string;
}

/** Framing copy for one experiment. */
export interface ExperimentExplainer {
  /** One-sentence summary of what the experiment measures. */
  readonly lede: string;
  /** "How to read the results" body, as one or more paragraphs. */
  readonly body: readonly string[];
  /** The experiment's conditions, in decomposition order. */
  readonly conditions: readonly ExplainerCondition[];
  /** Optional small-print reading note rendered after the condition list. */
  readonly readingNote?: string;
}

const EXPLAINERS: Readonly<Record<string, ExperimentExplainer>> = {
  "babel-relay": {
    lede: "Babel Relay measures what happens when the meaning of a shared term silently drifts while work passes through a relay of agents — and which mechanism, if any, surfaces the drift before it becomes a wrong outcome.",
    body: [
      "Each trial sends a small contract definition through a three-hop relay (specification → implementation → audit). In drift scenarios, one field of the definition is silently mutated at a relay boundary; the audit agent must then decide whether the implementation matches the definition it can see. The primary endpoints are silent divergence (drift that no agent ever surfaced) and task success, scored by a frozen deterministic parser — no LLM judge.",
      "The five conditions decompose where protection could come from, so that a content effect is never attributed to hashing, and a detection effect is never attributed to enforcement.",
    ],
    conditions: [
      {
        term: "baseline",
        description:
          "No semantic material beyond the task itself. Measures the floor.",
      },
      {
        term: "equal-prose",
        description:
          "The full definitions travel inline as prose. Isolates the value of content alone.",
      },
      {
        term: "opaque-resolver",
        description:
          "The same definitions behind a content-free lookup ID. Controls for compact references without content addressing.",
      },
      {
        term: "addressed-voluntary",
        description:
          "Content-addressed references; agents may check them but nothing compels action. Isolates detection.",
      },
      {
        term: "addressed-enforced",
        description:
          "Content-addressed references plus a runtime that refuses to proceed while reference and definition disagree. Isolates enforcement.",
      },
    ],
    readingNote:
      "Runs are labelled by evidence tier — deterministic harness validation, exploratory model pilot, or preregistered experiment — and nothing stronger than its label should be inferred from any table.",
  },
  "sema-tax": {
    lede: "The Sema tax curve prices what an agent pays — in tokens, bytes, and cost — to carry an increasing number of semantic patterns, and what that overhead buys in task quality.",
    body: [
      "Each trial gives a model a worksheet whose items can only be answered correctly using the definitions of the patterns currently active (0 to 16). Definitions arrive either inline as prose, behind an opaque lookup, or as content-addressed references; resolver arms additionally vary whether the local registry is cold (references must be hydrated) or warm. The primary endpoint is task success per total model token. Provider-side prompt-cache telemetry is recorded but observational (see ADR 0011); the controlled cache effect is hydration bytes.",
    ],
    conditions: [
      {
        term: "p0-baseline",
        description: "No patterns active. The shared origin of every curve.",
      },
      {
        term: "pN-prose-*",
        description:
          "N pattern definitions inline as prose. Pays wire bytes up front, no hydration.",
      },
      {
        term: "pN-opaque-*",
        description:
          "N patterns behind content-free lookup IDs. Pays hydration on a cold registry.",
      },
      {
        term: "pN-content-*",
        description:
          "N patterns as content-addressed references. Same hydration as opaque; the wire-byte difference is the addressing overhead itself.",
      },
    ],
  },
};

/**
 * Return the explainer content for an experiment, or `undefined` when no copy
 * is registered for that id (callers render nothing in that case).
 */
export function getExplainer(
  experimentId: string,
): ExperimentExplainer | undefined {
  return EXPLAINERS[experimentId];
}
