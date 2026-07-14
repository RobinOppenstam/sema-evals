# ADR 0001: Keep evaluations in a standalone repository

- Status: accepted
- Date: 2026-07-14

## Decision

Maintain `sema-evals` beside the upstream `sema` checkout rather than inside it
or HexSec.

## Rationale

- Experiment dependencies and release cadence differ from the Python protocol.
- Negative results and alternative controls must remain independent of upstream
  product claims.
- HexSec contributes adapters and benchmarks without becoming the only domain.
- Focused artifacts can still be proposed upstream after validation.

## Consequences

Sema integration is explicit and versioned. No experiment may depend on an
uncommitted modification in the sibling upstream checkout.
