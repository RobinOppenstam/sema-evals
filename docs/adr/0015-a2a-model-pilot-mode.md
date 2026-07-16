# ADR 0015: A2A drift model-pilot mode

- Status: accepted
- Date: 2026-07-16

## Context

ADR 0012 landed the deterministic A2A semantic-extension demo: a scripted
requester and scripted worker over an in-process transport, with controlled
cross-agent registry drift and an enforcement ladder
(`baseline` / `advertised-voluntary` / `advertised-enforced`). That ADR
explicitly deferred a model-pilot mode that drives real agents through the
existing provider adapters.

ADR 0005–0008 already define how model-pilot modes are built in this repo:
transcript-preserving adapters, objective DECISION parsing (no LLM judge),
frozen prompt snapshots, openai-compatible and Anthropic providers, bounded
concurrency, and per-request timeouts. This ADR wires that discipline into
`experiments/a2a-drift` without changing the deterministic harness.

## Decision

### Only the worker is model-driven

The requester, in-process transport, per-agent registries, drift injection,
acceptance-contract construction, and middleware
(`verifyAcceptanceContract` + `applyEnforcement`) remain deterministic and
byte-identical to the scripted demo. A single model adapter executes the
worker's task turn. This isolates whether a language-model worker _acts_ on
voluntary detection without confounding requester or transport variance.

### Prompt content and information parity

The worker receives a digest-stable user message built by
`buildWorkerUserMessage`:

- Always: the A2A TextPart task, requested handles, and worker-registry
  definitions (the worker always hydrates to do the work).
- Advertised conditions additionally: the acceptance-contract DataPart payload
  and the deterministic middleware verification report (digest comparison on
  the worker's own registry definitions).

No condition receives reasoning instructions the others lack beyond what the
wire already carries. Definitions and contracts are rendered with
key-sorted `stableJson` so the prompt is digest-stable for a given
(scenario, condition, registries, verification).

The system prompt is a frozen snapshot under
`experiments/a2a-drift/prompts/` (`worker.md`), loaded via
`loadPromptSnapshot` with fail-closed digest verification (ADR 0005).

### Objective DECISION parsing; middleware remains ground truth

The model must end with a line of the form
`DECISION: proceed|halt — <reason>` (reason optional). Parsing lives in a
frozen module versioned `a2a-decision-parser-v1`: markdown emphasis around the
keyword is stripped, matching is case-insensitive, the last matching line
wins, and unparseable output is preserved as `malformed` — never dropped
(ADR 0005).

**`driftDetected` is always the middleware's digest comparison**, never the
model's DECISION. The DECISION measures whether a model worker _acts_ on
voluntary detection (or otherwise chooses to halt). In
`advertised-enforced`, the middleware refuses `completed` on a mismatch
regardless of the model's decision — identical to the deterministic demo.

Terminal state:

- Middleware enforced halt → `failed` (typed `semantic-reference-mismatch`)
- Else model `halt` → `failed` (`model-worker-halt`)
- Else → `completed`
- Adapter non-completion or malformed DECISION → `taskSuccess = false`,
  output retained in the transcript

### Conditions and matrix unchanged

`baseline`, `advertised-voluntary`, and `advertised-enforced` are unchanged
and still planned via `planPairedMatrix` with the same scenario/seed blocks.
Deterministic mode remains the default and is byte-identical in behavior.

### Provider surface and telemetry

CLI flags match the babel-relay / sema-tax model-pilot surface:
`--mode model-pilot`, `--provider anthropic|openai-compatible`, `--base-url`,
`--model`, `--repetitions` (model-pilot default 5), `--concurrency`,
`--thinking`, `--max-tokens`, `--api-key-env`, plus the existing
`--semantic-backend` / `--sema-python`. Fail-fast when the selected provider's
API key env var is unset. Concurrency is ignored (with a note) in
deterministic mode (ADR 0008).

Trial records already compose core's `usageTelemetrySchema` and
`transcriptSchema` as nullable fields. Model-pilot fills them from the
adapter and additionally records `modelDecision` and
`decisionParserVersion`. The result manifest uses `mode: "model-pilot"` with
an exploratory evidence claim. Bundles are written through the existing
`writeResultBundleWith`.

### CI stays deterministic

Unit tests drive the model path with a scripted in-memory
`ModelAgentAdapter`. No live model calls and no network in CI.

## Consequences

- Operators can run an exploratory A2A worker pilot through real providers
  while keeping drift ground truth and enforcement deterministic.
- Deterministic-harness runs and their tests are unchanged.
- Confirmatory / preregistered A2A model evidence remains out of scope;
  this mode is labelled exploratory, matching ADR 0006 / 0007.
- Real-SDK / HTTP-transport conformance remains future work (ADR 0012).
