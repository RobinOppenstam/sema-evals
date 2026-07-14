# `@sema-evals/adapters`

Provider-neutral agent adapters plus a narrow bridge to the official Sema
Python implementation.

## Official Sema registry client

`SemaPythonRegistryClient` delegates registry creation, resolution, vocabulary
roots, and handshake verdicts to `semahash>=0.3.0,<0.4.0`. It requires an
explicit absolute SQLite path and never reads or changes Sema's active-database
configuration.

```ts
import { SemaPythonRegistryClient } from "@sema-evals/adapters";

const client = new SemaPythonRegistryClient({
  pythonCommand: "/absolute/path/to/python",
});

const remotePatternDigest = "<64-character SHA-256 received from the peer>";
const workspace = await client.describe("/absolute/path/to/vocabulary.db");
const result = await client.handshake(
  workspace.dbPath,
  "StateLock",
  remotePatternDigest,
);

if (result.verdict === "HALT") {
  // Fail closed or begin an explicit repair flow.
}
```

The client also exposes:

- `buildRegistry` — atomically mint a new database through Sema's graph store;
- `lookup` — resolve a handle or short reference;
- `resolve` — hydrate a pattern and dependency subgraph;
- `describe` — return the exact vocabulary root and workspace provenance; and
- `handshake` — compare a pattern digest or whole-vocabulary root.

`buildRegistry` refuses to overwrite existing files. Patterns with dependencies
must be supplied in dependency-first order.

## Fixture references

`FixtureReferenceProvider` is a fast evaluator test double. Its output is
labelled non-official and must not be presented as Sema-compatible. Use
`SemaPythonReferenceProvider` or `SemaPythonRegistryClient` for official runs.

All bridge responses are time-limited, output-limited, version-checked, and
schema-checked on the TypeScript side. Unknown Sema release lines fail closed.
