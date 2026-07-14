# Babel Relay

Babel Relay measures silent semantic drift across this boundary chain:

```text
spec agent -> planner -> implementation agent -> auditor
```

Each drift fixture changes one objective rule at a declared boundary. Clean
fixtures verify that fail-closed checks do not halt aligned agents.

## Current mode

The current relay agents are deterministic. The default semantic backend uses
fixture-generated references and proves that:

- all conditions run on paired scenario/seed blocks;
- condition order is reproducibly randomized;
- the opaque resolver cannot detect changed content under a stable label;
- a content-derived reference can expose the change;
- voluntary detection and enforced halt score differently;
- wire and hydration bytes remain separate;
- raw records reproduce the aggregate report.

This behavior is constructed and must not be presented as evidence about
language models. Fixture references use a clearly labelled local digest
backend. The optional official backend delegates reference generation,
registry minting, resolution, vocabulary roots, and handshake verdicts to
`semahash>=0.3.0,<0.4.0`. Unknown package lines fail closed until their
canonicalization and workspace behavior are reviewed.

For each run, the official preflight creates one canonical vocabulary and one
single-mutation vocabulary per drift fixture. It requires exact hydration
parity, verifies aligned states as `PROCEED`, verifies drifted states as `HALT`,
and records the original Sema payload in trial events. These databases are
temporary and never become the user's active Sema registry.

Resolution and handshake calls are prepared before the randomized trial loop.
That makes this a correctness PoC, not a handshake-latency benchmark; event
telemetry labels the execution mode explicitly.

## Run

```bash
pnpm experiment:babel
pnpm experiment:babel -- --seeds 5 --order-seed 20260714

pnpm experiment:babel -- \
  --semantic-backend sema-python \
  --sema-python ../sema/.venv/bin/python \
  --seeds 5
```

## Next adapters

1. Transcript-preserving model adapter with JSON-schema validation.
2. Repair-capable handshake adapter.
3. Persistent sidecar for cold/warm registry latency measurement.
4. A2A transport adapter.

No model pilot begins until the registry resolver and equal-information prompt
snapshots are present in the result manifest.
