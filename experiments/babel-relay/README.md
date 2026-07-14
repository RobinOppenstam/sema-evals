# Babel Relay

Babel Relay measures silent semantic drift across this boundary chain:

```text
spec agent -> planner -> implementation agent -> auditor
```

Each drift fixture changes one objective rule at a declared boundary. Clean
fixtures verify that fail-closed checks do not halt aligned agents.

## Current mode

The current adapter is deterministic. It proves that:

- all conditions run on paired scenario/seed blocks;
- condition order is reproducibly randomized;
- the opaque resolver cannot detect changed content under a stable label;
- a content-derived reference can expose the change;
- voluntary detection and enforced halt score differently;
- wire and hydration bytes remain separate;
- raw records reproduce the aggregate report.

This behavior is constructed and must not be presented as evidence about
language models or official Sema canonicalization. Fixture references use a
clearly labelled local digest backend.

## Run

```bash
pnpm experiment:babel
pnpm experiment:babel -- --seeds 5 --order-seed 20260714
```

## Next adapters

1. Official Sema v0.3 resolver through its Python API or MCP server.
2. Transcript-preserving model adapter with JSON-schema validation.
3. Repair-capable handshake adapter.
4. A2A transport adapter.

No model pilot begins until the official resolver and equal-information prompt
snapshots are present in the result manifest.
