# `@sema-evals/adapters`

Provider-neutral agent adapters plus a narrow bridge to the official Sema
Python implementation.

## Transcript-preserving model adapter

`AnthropicModelAdapter` calls the Anthropic Messages API and returns a
`ModelAgentResponse` that carries a verbatim `transcript` and `usage` telemetry
alongside the usual agent output. It exists so a model pilot can meet the
experiment standard's telemetry requirements before any live run.

```ts
import { AnthropicModelAdapter } from "@sema-evals/adapters";

const adapter = new AnthropicModelAdapter({
  systemPrompt: frozenSnapshot, // a frozen prompt snapshot, hashed into provenance
  model: "claude-opus-4-8", // default
  maxTokens: 4096,
  maxRetries: 4,
});

const response = await adapter.invoke({
  messages: [{ role: "user", content: taskPayload }],
});
// response.output.status: "completed" | "refused" | "truncated" | "error"
// response.transcript.entries: system, each turn, one entry per attempt
// response.usage: token counts, attempts, retries, errors, stopReason
```

Guarantees:

- **Recorded retries, not silent ones.** The Anthropic client is constructed
  with `maxRetries: 0`; the adapter retries only rate-limit, overload, 5xx, and
  connection errors with bounded exponential backoff, and appends every attempt
  to the transcript and usage telemetry.
- **Failures preserved.** Refusals, `max_tokens` truncations, and non-retryable
  errors are returned as preserved records — `invoke` does not throw for provider
  outcomes. A malformed or refused output becomes a failed trial record, not a
  dropped one.
- **No sampling parameters.** `temperature`/`top_p`/`top_k` are never sent (they
  are rejected on Opus 4.8); the adapter always sends
  `thinking: { type: "adaptive" }`. Reasoning tokens are recorded as `null`.
- **Injectable client.** The constructor accepts a minimal
  `{ messages: { create } }` client so unit tests use a fake and CI never touches
  the network.

Frozen prompt snapshots are loaded with `loadPromptSnapshot` from
`@sema-evals/core`, which recomputes each file's SHA-256, fails closed on drift,
and exposes the combined `promptDigest` recorded in trial provenance.

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
