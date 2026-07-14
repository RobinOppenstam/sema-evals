# ADR 0006: Model-pilot run mode for the Babel Relay

- Status: accepted
- Date: 2026-07-14

## Context

ADR 0005 landed the infrastructure for a model pilot — a transcript-preserving
`AnthropicModelAdapter`, usage telemetry, and frozen, digest-verified prompt
snapshots — but deliberately left the wiring to a later change. The deterministic
Babel Relay still drives every agent as a pure function. This milestone adds a
`model-pilot` run mode that replays the same three-boundary relay through real
model calls while keeping the primary endpoint objective and preserving every
output, including failures.

## Decision

### Objective DECISION parsing instead of an LLM judge

The audit agent must end its response with a single final line, uppercase,
`DECISION: PROCEED` or `DECISION: HALT`. The harness parses the last matching
line; anything else is `malformed`. This keeps scoring deterministic and avoids
using a model as the only scorer, which the experiment standard forbids. The
convention lives in the frozen `implementation-to-audit.md` prompt. Adding it
required amending that file, so its SHA-256 was regenerated in
`prompts/manifest.json` and `snapshotVersion` was bumped from `2026-07-14` to
`2026-07-14.1`. The digest check is never bypassed; amending a prompt and
recomputing its digest is the sanctioned way to change a prompt.

Outputs that do not parse are preserved as schema-valid records with
`taskSuccess = false` and the malformed text retained in the transcript. They are
never dropped or retried for content reasons; adapter-level retries remain
limited to rate-limit, overload, 5xx, and connection failures.

### Per-boundary adapters with frozen prompts

Each boundary hop (spec-to-plan, plan-to-implementation, implementation-to-audit)
uses its corresponding frozen prompt snapshot as the system prompt, through one
`AnthropicModelAdapter` per boundary constructed once per run rather than per
trial. The user message carries the upstream artifact plus the semantic material
rendered per condition policy: inline definition for equal-prose, an opaque
reference plus resolved definition for opaque-resolver, and a content-addressed
reference plus resolved definition for the addressed conditions. Baseline
receives the task alone.

### Information parity is preserved

The resolved-definition block is rendered with a byte-stable, key-sorted
serializer, so it is byte-identical across equal-prose, opaque-resolver, and the
addressed conditions regardless of whether the definition arrived inline or via
registry hydration. Only the reference lines above the block differ between
conditions. No condition receives reasoning instructions the others lack; the
content-addressing check remains a harness-side reference comparison, exactly as
in the deterministic relay — the model never recomputes a hash, and the
verification verdict is never injected into the model's context. Enforced
conditions halt at the boundary where verification fails, skipping the downstream
hops (and their model calls) just as the deterministic relay does.

### Usage aggregated across hops; transcripts concatenated

Every model-pilot trial record carries non-null `usage` aggregated across its
hops — token fields, attempts, retries, and latency sum; errors concatenate;
reasoning tokens stay `null` unless a hop reports a number — and a non-null
`transcript` that concatenates the per-hop transcripts with globally sequential
indices. Each hop's leading `system` entry carries its frozen boundary prompt, so
boundaries stay identifiable without a schema change, and per-hop model telemetry
is also recorded in the trial events. Provenance records `modelProvider`
`anthropic`, `modelName` as the exact model id, and `promptDigest` as the loaded
snapshot's combined digest.

### A cheaper default model, and exploratory labelling

The default pilot model is `claude-sonnet-5`, not a frontier model. A frontier
model risks a ceiling effect: if it silently never diverges, the pilot cannot
discriminate between conditions. The research plan calls for two model families
in later phases; the pilot begins with a mid-tier model to leave headroom for a
measurable silent-divergence signal. The adapter's new `thinkingMode` option
(`adaptive` default, `none` for models such as `claude-haiku-4-5` that do not
support adaptive thinking) makes swapping model families cheap; `none` omits the
`thinking` field entirely rather than sending `{ type: "disabled" }`.

The result manifest records `mode: "model-pilot"` and an evidence claim that
labels the run exploratory: "Exploratory model pilot. Not preregistered, not
confirmatory evidence." Deterministic-harness runs are byte-for-byte unchanged.

## Consequences

- The Babel Relay can now be driven by real models with objective scoring,
  lossless per-trial usage and transcripts, and full provenance.
- CI runs no live model: the model-relay unit tests inject fake Anthropic
  clients, and `model-pilot` mode fails fast when `ANTHROPIC_API_KEY` is unset.
- The pilot is a two-stage procedure: run the instrumentation size (five paired
  repetitions) first to validate mechanics and spend, then scale to at least 30
  repetitions for the first real pilot per the research plan.
- Before the instrumentation run can execute, an operator must supply an API key
  and accept the printed spend shape; nothing about the causal design or scorer
  changes between instrumentation and pilot.
