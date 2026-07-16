# ADR 0014: Security domain experiment scaffold

- Status: accepted
- Date: 2026-07-16

## Context

RESEARCH_PLAN Phase 4 asks for security-domain trials on a public `sema-sec`
candidate vocabulary evaluated against mutation-backed Solidity cases. The
primary endpoint is **vulnerability recall at a fixed false-positive budget**.
The exit gate (full Phase 4) requires at least 30 cases, clean negatives,
train/heldout separation, Foundry ground truth where possible, two model
families, and no domain knowledge leaked from heldout fixtures into Pattern
Cards.

This ADR accepts the **scaffold only**: fixtures, schemas, condition ladder,
deterministic scorer, leakage guard, CLI skeleton, and unit coverage. No
model-pilot execution is wired here.

Phases 1–3 built the reusable spine this package reuses unchanged:
`planPairedMatrix` / `executeMatrix`, `FixtureReferenceProvider` /
`SemaPythonReferenceProvider`, and `writeResultBundleWith`. ADR 0002's content /
addressing / enforcement decomposition remains binding.

## Decision

### Mutation-backed Solidity fixtures

Ship a seed set of **9 cases** across three vulnerability classes (reentrancy,
access control, unchecked external-call return). Each case is one small
self-contained Solidity ^0.8 contract in two variants — `vulnerable.sol` (the
mutation applied) and `patched.sol` (the clean negative) — plus a `case.json`
with id, class, precise mutation description and distinguishing real-code
snippets (`vulnerableSnippet` / `patchedSnippet`), `split: "train" | "heldout"`,
expected findings, and identifier lists for the leakage guard.

**Invariant:** fixture `.sol` source is model-facing prompt material. Ground
truth (class labels, expected findings, mutation snippets, split) lives only in
`case.json`. Never embed vulnerability annotations, `VULN` markers, or class-name
spoilers in contract source comments — integrity and annotation-leakage tests
enforce this permanently.

Split: **5 train / 4 heldout**, every class present in both. Contracts are
original, minimal (< ~80 lines). Compilation is not part of CI.

### Foundry ground truth is optional and gated

`foundry/` holds a PoC test skeleton per train case. The CLI accepts
`--with-foundry` and probes `FOUNDRY_BIN` / `forge` on PATH. When Foundry is
absent the path is a **no-op**. CI never requires Foundry.

### Pattern Cards: `sema-sec` candidate vocabulary

One card per vulnerability class (3 cards), describing the pattern generically
and derivable from the train split only. Enforced by `leakage.test.ts`: the
guard fails if any heldout-unique identifier (contract, function, or variable
name listed only on heldout cases) appears in any Pattern Card text.

### Condition ladder

Four conditions mirror ADR 0002 without an opaque-resolver arm (addressing is
isolated by equal-prose vs addressed-voluntary):

| Condition             | Isolates                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `baseline`            | Task-only; no cards                                                                                                            |
| `equal-prose`         | Card content inlined; no references                                                                                            |
| `addressed-voluntary` | Content-addressed card references via the shared reference-provider abstraction                                                |
| `addressed-enforced`  | Auditor must emit `DECISION: ADDRESS <digests>`; a deterministic gate refuses findings that do not address required references |

### Scorer: `security-scorer-v1`

Frozen, versioned, deterministic. Auditor output convention:

```
FINDING: <class> @ <function>
DECISION: NONE | SUBMIT | ADDRESS <digest>[, <digest>...]
```

Output: per-trial TP / FP / FN against `case.json` labels. Primary reporting:
recall at a fixed false-positive budget (`--fp-budget`, default 1 per case).
Unparseable output is preserved as failure, never dropped.

### Instrumentation CLI

`--mode instrumentation` runs the deterministic path end-to-end with canned
auditor outputs through `planPairedMatrix` / `executeMatrix` and writes a real
bundle via `writeResultBundleWith` with experiment-specific record/manifest
schemas, summarizer, and markdown renderer. Root script:
`pnpm experiment:security`.

## Consequences

- Phase 4 has a real package that CI can exercise fully without network,
  Foundry, or live models.
- Train/heldout separation is an executable invariant, not a documentation
  promise.
- Deterministic harness outcomes are a construction, not evidence about
  language models — manifests and summaries say so.

## Future work (not in this PR)

- Model-pilot mode via existing adapters (two model families).
- Scale fixtures to ≥30 cases with clean negatives.
- Foundry-verified ground truth for train PoCs (beyond skeleton placeholders).
- Confirmatory protocol / preregistration once the pilot design freezes.
