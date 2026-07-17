# Security domain trials

Deterministic scaffold for RESEARCH_PLAN Phase 4: vulnerability recall at a
fixed false-positive budget on mutation-backed Solidity cases.

Every case runs twice: the vulnerable source and its patched clean negative.
The model-facing task contains Solidity source only; class, case id, source
variant, split, mutation metadata, and labels remain scorer-side ground truth.

Primary endpoint: **micro vulnerability recall over vulnerable variants,
reported only when total false-positive findings across both variants remain
within the aggregate allowance** (`--fp-budget` per evaluated source).

## Evidence role

This is a **workflow-utility scaffold** for contract review. The current
deterministic auditor validates fixtures, clean negatives, leakage controls,
scoring, and reporting only. It does not show that a model finds more
vulnerabilities. Real utility evaluation is gated on acquiring and freezing a
larger held-out corpus before prompts or Pattern Cards are tuned to it.

## Package

`@sema-evals/security` — fixtures, `sema-sec` Pattern Cards, condition ladder,
deterministic scorer (`security-scorer-v1`), leakage guard, and an
instrumentation CLI. No live model calls.

See [ADR 0014](../../docs/adr/0014-security-experiment-scaffold.md).

## Run

```bash
pnpm experiment:security -- --mode instrumentation
```

Optional Foundry PoC stubs live under `foundry/` (train cases only). Pass
`--with-foundry` or set `FOUNDRY_BIN`; absent Foundry is a no-op. CI never
requires Foundry.

## Phase 13 executor contract

`src/model-executor.ts` defines the no-live-call controlled-auditor contract,
provider factory, and transcript/failure preservation schema. Its
`model-readiness.json` gate remains blocked until the held-out corpus, model
configuration, and verified writable harness exist.
