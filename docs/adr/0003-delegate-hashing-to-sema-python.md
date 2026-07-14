# ADR 0003: Delegate official hashing to semahash Python

- Status: accepted
- Date: 2026-07-14

## Decision

Generate official Sema references by invoking `sema.core.hashing` from an
installed `semahash>=0.3.0` Python interpreter. Keep the fixture digest provider
for fast evaluator tests, but label it non-official in every artifact.

Do not independently implement canonicalization v2 in TypeScript as part of the
experiment harness.

## Rationale

An approximate port would create a second semantic authority and could silently
diverge on Unicode normalization, JSON primitive representation, dependency
aliases, or future canonicalization changes. The official package is the source
of truth. A narrow JSON-over-stdio bridge keeps the TypeScript experiment stack
provider-neutral without changing the algorithm being evaluated.

## Consequences

- Official-backend runs require Python and `semahash>=0.3.0`.
- The bridge is time-limited, output-limited, schema-checked, and cache-backed.
- Package and canonicalization versions are recorded in result provenance.
- A future native TypeScript implementation must begin as a differential
  conformance project and cannot replace the official backend until it matches
  published vectors.
