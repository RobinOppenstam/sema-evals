# Security domain trials

Deterministic scaffold for RESEARCH_PLAN Phase 4: vulnerability recall at a
fixed false-positive budget on mutation-backed Solidity cases.

Primary endpoint: **vulnerability recall at a fixed false-positive budget**.

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
