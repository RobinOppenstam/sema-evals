# ADR 0005: Transcript-preserving model adapter and frozen prompts

- Status: accepted
- Date: 2026-07-14

## Context

The deterministic Babel Relay validates condition mechanics, drift scoring, and
artifact reporting, but every agent is a pure function. Before the first
exploratory model pilot we need infrastructure that satisfies the experiment
standard's telemetry and provenance requirements for real model calls, without
running any live model in CI.

## Decision

### Adapter-level recorded retries instead of SDK silent retries

`AnthropicModelAdapter` constructs its Anthropic client with `maxRetries: 0` and
implements retries itself. It retries only rate-limit (429), overload/5xx, and
connection errors, with bounded exponential backoff. Every attempt — success,
refusal, truncation, or error — is appended to the transcript and counted in
usage telemetry (`attempts`, `retries`, `errors`). The SDK's built-in retries
would discard the intermediate failed responses; the experiment standard forbids
selectively dropping inconvenient outputs, so retries must be observable in the
record.

Non-retryable errors (400, 401, 403, ...) and provider outcomes
(`stop_reason: "refusal"` / `"max_tokens"`) are never thrown away. `invoke` does
not throw for provider outcomes: a refused, truncated, or errored call returns a
preserved response with the failure recorded, matching "model outputs are
schema-valid or preserved as failures".

### Transcripts preserved verbatim

Every message exchanged is recorded in order: the frozen system prompt, each
input turn, and one assistant (or error) entry per attempt. Assistant entries
capture every content block — including the presence of thinking blocks whose
text is omitted on Opus 4.8 — and each entry keeps the raw provider payload as
`raw: unknown`. Reasoning tokens are not reported separately by the provider and
are recorded as `null` rather than guessed.

Sampling parameters (`temperature`, `top_p`, `top_k`) are never sent: they are
rejected on Opus 4.8. The adapter always sends `thinking: { type: "adaptive" }`.

### Frozen prompt snapshots with fail-closed digest verification

The model pilot's prompts live under `experiments/babel-relay/prompts/`, one
file per relay boundary, with a `manifest.json` recording each file's SHA-256 and
a snapshot version. `loadPromptSnapshot` recomputes each digest and refuses to
load if any file disagrees with the manifest — a drifted prompt must never run
silently. The loader also derives the combined `promptDigest` used in
`trialProvenanceSchema`. The prompts are condition-agnostic role prompts, so
information parity across conditions is preserved: reasoning instructions are not
added only to the content-addressed arm.

### Version bump to 0.3.0

`usageTelemetrySchema` and a transcript schema are added to `@sema-evals/core`
and wired into `trialRecordSchema` as nullable `usage` and `transcript` fields,
so deterministic-harness records remain valid with `null`. `PROTOCOL_VERSION` and
`ARTIFACT_SCHEMA_VERSION` move to `0.3.0`, and the generated JSON schemas are
regenerated.

## Consequences

- Model trials carry a lossless, auditable transcript and usage record; retries
  can never silently drop an output.
- Deterministic records set `usage` and `transcript` to `null` and validate
  unchanged.
- Unit tests drive the adapter through an injected fake client, so CI never
  touches the network; the live integration test is gated behind
  `ANTHROPIC_API_KEY`.
- Wiring the adapter and frozen prompts into a model-pilot run mode of the Babel
  Relay CLI is deliberately left to the next PR; this milestone only lands the
  infrastructure.
