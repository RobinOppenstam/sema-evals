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

## Run (deterministic harness)

```bash
pnpm experiment:babel
pnpm experiment:babel -- --seeds 5 --order-seed 20260714

pnpm experiment:babel -- \
  --semantic-backend sema-python \
  --sema-python ../sema/.venv/bin/python \
  --seeds 5
```

## Run (model pilot)

The `model-pilot` mode replays the same three boundaries through real Anthropic
model calls, using the frozen, digest-verified prompt snapshots under
`prompts/`. The audit agent must end with a strict final line — `DECISION:
PROCEED` or `DECISION: HALT` — which the harness parses objectively; malformed
audit output is preserved as a failure, never dropped or retried for content.

This mode is exploratory. Its result manifest is labelled "Exploratory model
pilot. Not preregistered, not confirmatory evidence." It is never confirmatory
evidence that Sema improves model performance.

> **Spend shape.** Each trial makes up to three model calls (one per boundary;
> enforced halts skip downstream calls). Total calls scale as
> scenarios × conditions × repetitions × 3. With six scenarios, five conditions,
> and five repetitions that is 150 trials and up to 450 model calls. The CLI
> prints the trial count, model-call ceiling, and model id before it runs so you
> see the cost before spending it.

`model-pilot` mode requires the selected provider's API key env var
(`ANTHROPIC_API_KEY` for anthropic, `CHUTES_API_KEY` for openai-compatible); it
fails fast if the key is unset. It never runs in CI — the model-relay tests
inject fake clients and a fake `fetch`.

Run the small instrumentation size first, then scale:

```bash
# Stage 1 — instrumentation (validate mechanics and spend at five repetitions)
ANTHROPIC_API_KEY=... pnpm experiment:babel -- \
  --mode model-pilot --model claude-sonnet-5 --repetitions 5

# Stage 2 — first pilot (at least 30 repetitions per the research plan)
ANTHROPIC_API_KEY=... pnpm experiment:babel -- \
  --mode model-pilot --model claude-sonnet-5 --repetitions 30
```

### Run against an OpenAI-compatible endpoint (Chutes)

The `openai-compatible` provider drives the same three boundaries through any
endpoint that speaks the OpenAI chat-completions protocol — Chutes and other
decentralized/self-hosted inference services — for cheap exploratory
cross-family signal. It uses the Node built-in `fetch` (no extra dependency) and
preserves transcripts, retries, and failures exactly like the Anthropic adapter.

```bash
# Stage 1 — instrumentation against Chutes (validate mechanics and spend)
CHUTES_API_KEY=... pnpm experiment:babel -- \
  --mode model-pilot \
  --provider openai-compatible \
  --base-url https://llm.chutes.ai/v1 \
  --model zai-org/GLM-4.6-FP8 \
  --repetitions 5 \
  --concurrency 8
```

Decentralized endpoints spend most of a call queued before generation starts
(roughly 36s of a ~95s call in the first Chutes pilot), so trials are heavily
network-bound. `--concurrency 8` overlaps that queue latency across trials and
cuts a large run's wall-clock time by close to an order of magnitude without
changing what is measured: trials are still STARTED in the planned,
seed-randomized order, at most N run at once, and each record timestamps its own
execution window. Records are written in planned order regardless of completion
order. In model-pilot mode the CLI streams one progress line per completed trial
to stderr (stdout stays reserved for the summary, so piping is unaffected). See
[ADR 0008](../../docs/adr/0008-concurrent-execution-and-timeouts.md).

`--base-url` and `--model` are required for `openai-compatible` (there is no
default model — catalog slugs vary by endpoint), and the run fails fast if
`CHUTES_API_KEY` (or the env var named by `--api-key-env`) is unset. `--thinking`
applies only to the anthropic provider and is rejected here. Provenance records
`modelProvider` as the base-URL host (for example `llm.chutes.ai`) and
`modelName` as the exact slug. Decentralized serving cannot pin a model version,
so these runs stay labelled exploratory. See
[ADR 0007](../../docs/adr/0007-openai-compatible-provider-adapter.md).

Model-pilot flags:

- `--provider anthropic|openai-compatible` (default `anthropic`).
- `--base-url <url>` — required for `openai-compatible` (e.g.
  `https://llm.chutes.ai/v1`); ignored for anthropic.
- `--api-key-env <name>` — env var holding the API key (default
  `ANTHROPIC_API_KEY` for anthropic, `CHUTES_API_KEY` for openai-compatible).
- `--model <id>` (anthropic default `claude-sonnet-5`; required for
  openai-compatible) — a mid-tier default avoids the ceiling effect a frontier
  model can produce.
- `--thinking adaptive|none` (default `adaptive`; anthropic only) — use `none`
  for models such as `claude-haiku-4-5` that do not support adaptive thinking.
  Pairing `claude-haiku-4-5` with `adaptive`, or passing `--thinking` with
  `openai-compatible`, fails fast.
- `--max-tokens <n>` (default 4096) per hop.
- `--repetitions <n>` — alias for `--seeds`; the model-pilot default is 5.
- `--concurrency <n>` (default 1, max 32) — trials in flight at once. Only
  meaningful in model-pilot mode (network-bound); a value above 1 is ignored
  with a note in deterministic mode. Suggested `--concurrency 8` for Chutes.
  Each adapter also enforces a per-request timeout (openai-compatible default
  120s, anthropic default 600s), recorded as a retryable connection error.

The semantic backend flags (`--semantic-backend`, `--sema-python`) compose with
`model-pilot` exactly as they do with the deterministic harness.

## Next adapters

1. Repair-capable handshake adapter.
2. Persistent sidecar for cold/warm registry latency measurement.
3. A2A transport adapter.
