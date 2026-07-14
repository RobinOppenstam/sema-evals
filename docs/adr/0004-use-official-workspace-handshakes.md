# ADR 0004: Use explicit official Sema workspaces for registry experiments

- Status: accepted
- Date: 2026-07-14

## Decision

Build experiment vocabularies with Sema's `GraphStore` and `mint_pattern`, then
resolve and verify them through `GraphWorkspace` using an explicit absolute
database path. Do not select registries through Sema's process-wide active
database configuration.

The Babel Relay official-backend preflight creates one canonical vocabulary
and one single-mutation vocabulary per drift fixture in a temporary directory.
It checks that:

- every Pattern Card passes the official schema and mint pipeline;
- registry hydration reproduces the fixture definition exactly;
- the direct canonical reference and stored registry identity agree;
- aligned handshakes return `PROCEED`;
- controlled drift returns `HALT`; and
- each drift changes the vocabulary root.

Pattern embeddings are replaced with deterministic zero vectors while building
these fixtures. Search quality is outside this experiment, embeddings are not
part of a Sema identity, and this avoids a model download or network dependency
in the deterministic harness.

## Rationale

Reimplementing lookup or handshake logic in TypeScript would create a second
semantic authority. Driving the global MCP registry would make parallel tests
stateful and could overwrite a contributor's active Sema configuration. An
explicit `GraphWorkspace` keeps each simulated agent's vocabulary isolated and
makes cross-registry drift reproducible.

The current bridge prepares resolutions and handshake verdicts before trial
execution. This keeps randomized condition timing free of Python process-start
cache effects and is sufficient for correctness experiments.

## Consequences

- Registry paths are absolute and existing databases are never overwritten.
- Temporary vocabularies are removed after a run, including failed runs.
- Official registry tests require the runtime dependencies used by Sema's graph
  and schema modules.
- Trial events retain the original official handshake payload and the local
  vocabulary root.
- Trial `elapsedMs` excludes registry construction and Python bridge startup;
  this implementation must not be used to claim handshake-latency results.
- A future latency experiment needs a persistent sidecar or MCP session with
  explicit cold/warm cache telemetry.
