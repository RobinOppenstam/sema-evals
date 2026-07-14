# ADR 0007: A second provider family via the OpenAI-compatible protocol

- Status: accepted
- Date: 2026-07-14

## Context

ADR 0005 and ADR 0006 landed a transcript-preserving `AnthropicModelAdapter`
and a `model-pilot` run mode driven by a single provider family. The research
plan calls for at least two model families so a silent-divergence signal is not
an artifact of one vendor's behavior, and it wants cheap exploratory signal
before spending on a confirmatory run.

Most decentralized and self-hosted inference services — Chutes among them —
speak the OpenAI chat-completions protocol rather than the Anthropic Messages
protocol. Adding an OpenAI-compatible adapter therefore unlocks a large, cheap
set of open-weight models (for exploratory cross-family comparison) through a
single code path, without a per-vendor SDK.

## Decision

### `OpenAiCompatibleModelAdapter` with identical preservation semantics

A new `OpenAiCompatibleModelAdapter` implements the same
`ModelAgentAdapter<ModelPromptInput, ModelCompletion>` interface as the
Anthropic adapter and preserves the same guarantees: the transcript records the
system prompt, each input turn, and every attempt — success or error — in order
with raw payloads; retries are adapter-level, bounded exponential backoff, and
fire only on 429/5xx/connection errors, with every attempt recorded; refusals
(`finish_reason: "content_filter"`), truncations (`"length"`), non-retryable
HTTP errors, malformed bodies, and missing-choices responses are returned as
preserved failure records. `invoke` never throws for a provider outcome. The
only difference from the Anthropic adapter is the wire protocol.

### No new dependencies; Node built-in `fetch`

The adapter speaks chat-completions over the Node 22 built-in `fetch` and adds
no npm dependency. `fetch` is injectable (`fetchFn`) so unit tests drive it with
fakes and CI never touches the network, exactly as the Anthropic adapter injects
a fake client. Requests POST to `${baseUrl}/chat/completions` with
`{ model, max_tokens, messages }` and send no sampling parameters
(`temperature`/`top_p`/`top_k` are omitted entirely), matching the repo's
determinism-by-prompting stance.

### Response and usage mapping, degrading rather than throwing

`choices[0].message.content` maps to the completion text and `finish_reason`
maps to status: `stop` completes, `length` truncates, `content_filter` refuses,
and any other value is preserved verbatim as the stop reason (completing when
text is present, erroring on empty content). Usage maps `prompt_tokens` →
`inputTokens`, `completion_tokens` → `outputTokens`,
`prompt_tokens_details.cached_tokens` → `cachedInputTokensRead` (0 when absent),
`cachedInputTokensWritten` is always 0, and
`completion_tokens_details.reasoning_tokens` → `reasoningTokens` (null when
absent); `costUsd` is null. Malformed or missing fields degrade to zeros/nulls
and the raw body is preserved; they never throw.

### The API key is never logged or stored

The key is read lazily from `process.env[apiKeyEnvVar]` (default
`CHUTES_API_KEY`) at the first invoke and used only in the `Authorization`
header on the wire. It is never written to a transcript, a raw record, or a log.
Where request metadata is recorded on an error entry, the `Authorization` header
is redacted to `Bearer [REDACTED]`. A unit test asserts the key string never
appears anywhere in the returned record or transcript JSON. Preserved HTTP and
malformed-body payloads are capped at 64 KB with truncation noted, so a
pathological response cannot bloat a result bundle.

### Provenance convention: `modelProvider` is the base-URL host

For an OpenAI-compatible run, `modelProvider` is recorded as the base-URL host
(for example `llm.chutes.ai`), not the literal string `openai-compatible`,
because the protocol is shared across many endpoints and the host is what
identifies the actual service. `modelName` is the exact model slug passed on the
command line. For the Anthropic provider, `modelProvider` remains `anthropic`.
There is no default model for the openai-compatible provider — catalog slugs
vary by endpoint, so `--model` is required and fails fast when omitted.

### No snapshot pinning for decentralized serving

Decentralized inference cannot pin a model version the way a first-party API
snapshot can: the same slug may be served by different nodes with different
weights or runtime builds, and the service does not expose a reproducible
version handle. Runs through this adapter therefore carry no version pin beyond
the slug, and the model-pilot run remains labelled exploratory
("Exploratory model pilot. Not preregistered, not confirmatory evidence.").
A confirmatory run must use an endpoint that can pin a model version, or must
document the unpinned serving explicitly as a limitation.

## Consequences

- The Babel Relay model pilot can now be driven by any OpenAI-compatible
  endpoint, unlocking cheap open-weight models for exploratory cross-family
  comparison through one code path and no new dependency.
- CI runs no live model: the adapter tests inject a fake `fetch`, and
  `model-pilot` mode fails fast when the selected provider's key env var is
  unset or when `--base-url`/`--model` are missing for openai-compatible.
- Cross-family signal is exploratory only until a version-pinnable endpoint and
  a preregistered design are in place; the provenance and manifest labels carry
  this caveat.
