# Sema tax curve

Phase 2 of the [research plan](../../docs/RESEARCH_PLAN.md). The tax curve asks
what an agent pays, in total model tokens, to carry more semantic patterns, and
how that cost trades against task quality.

**Primary endpoint: task success per total model token.**

Design and rationale: [ADR 0010](../../docs/adr/0010-sema-tax-experiment-design.md).

## The task family

Each scenario is a **worksheet** of items. Every item names a pattern (a compact
card of `comparator`, `threshold`, `unit`) and a value, and asks whether the
value satisfies the pattern. Ground truth is the executable predicate
`value <comparator> threshold`, so scoring is objective — no LLM judge.

The **active pattern set** for pattern count N is the first N handles of the
scenario's priority-ordered pool. An item is answerable only when its pattern is
active. Because items reference patterns spread across the pool, coverage rises
with N but with diminishing marginal benefit, while token cost rises roughly
linearly — so _success per token_ traces a genuine cost/benefit curve. The
`p0-baseline` anchor is the curve's origin.

## Conditions

`1 anchor + 5 counts x 3 deliveries x 2 caches = 31` conditions:

- **Pattern count**: `0, 2, 4, 8, 12, 16` (count 0 is the single shared
  baseline; delivery and cache are undefined with no patterns).
- **Delivery**: `prose` (full definitions inline), `opaque` (compact content-free
  lookup labels), `content` (content-addressed references).
- **Cache**: `cold` (definitions fetched fresh) and `warm` (definitions resident
  locally / in the prompt cache).

Information parity holds: for a given active set the resolved-definitions block
is byte-identical across all delivery arms and cache states; only the reference
material above it differs. The opaque arm controls for compact lookup so any
opaque-vs-content difference is attributable to content-addressing itself (ADR
0002). Wire bytes and hydration bytes are recorded as separate channels, and the
cold/warm split is recorded in the token account and cost — not in token
throughput.

## Run (deterministic harness)

```bash
pnpm experiment:sema-tax
pnpm experiment:sema-tax -- --seeds 2 --order-seed 20260714
```

The deterministic executor scripts a worksheet agent that answers an item
correctly exactly when its pattern is active. It exercises every metric channel
— wire bytes, hydration bytes, the cold/warm token split, cost, and graded
quality — with exact, reproducible aggregates and no model spend. This behavior
is constructed and is not evidence about language models; the bundle and summary
say so, and deterministic token prices are illustrative.

## Run (model pilot)

The `model-pilot` mode drives the same worksheets through a real model using the
frozen, digest-verified prompt under `prompts/`. The agent must end with strict
`ITEM <id>: yes|no` lines, which the harness parses objectively; a malformed or
missing answer is scored wrong and never dropped, and a failed model call is
preserved as a zero-score record with its transcript.

This mode is exploratory. Its manifest is labelled "Exploratory model pilot. Not
preregistered, not confirmatory evidence."

> **Spend shape.** One model call per trial. Total calls scale as
> scenarios × conditions × repetitions. With three scenarios, 31 conditions, and
> five repetitions that is 465 trials and 465 model calls. The CLI prints the
> trial count, model-call ceiling, and model id before it runs.

Run the small instrumentation size first, then scale (the standard two-stage
discipline from Phase 1):

```bash
# Stage 1 - instrumentation (validate mechanics and spend at five repetitions)
ANTHROPIC_API_KEY=... pnpm experiment:sema-tax -- \
  --mode model-pilot --model claude-sonnet-5 --repetitions 5

# Stage 2 - first exploratory pilot (at least 30 repetitions)
ANTHROPIC_API_KEY=... pnpm experiment:sema-tax -- \
  --mode model-pilot --model claude-sonnet-5 --repetitions 30
```

### Against an OpenAI-compatible endpoint (Chutes)

```bash
CHUTES_API_KEY=... pnpm experiment:sema-tax -- \
  --mode model-pilot \
  --provider openai-compatible \
  --base-url https://llm.chutes.ai/v1 \
  --model zai-org/GLM-4.6-FP8 \
  --repetitions 5 \
  --concurrency 8
```

Model-pilot flags match the Babel Relay exactly (`--provider`, `--base-url`,
`--api-key-env`, `--model`, `--thinking`, `--max-tokens`, `--repetitions`,
`--concurrency`); see the [Babel Relay README](../babel-relay/README.md) and
[ADR 0007](../../docs/adr/0007-openai-compatible-provider-adapter.md) /
[ADR 0008](../../docs/adr/0008-concurrent-execution-and-timeouts.md). Trials are
started in the planned, seed-randomized order; records are written in planned
order; one progress line per completed trial goes to stderr. `model-pilot` mode
fails fast when the selected provider's key env var is unset and never runs in
CI.

The semantic backend flags (`--semantic-backend`, `--sema-python`) compose with
either mode, exactly as in the Babel Relay.

## Result bundle

Each run writes `manifest.json`, `trials.jsonl`, `summary.json`, and
`summary.md` via `packages/reporters`. Metrics record, per trial and per
condition: graded score and task success, wire bytes, hydration bytes, input /
cached-input / output / total model tokens, cost, latency, and between-run
variance — each reported separately.

## Phase 2 exit gate

From the research plan: _wire bytes, hydration bytes, input/output tokens, cost,
latency, quality, and between-run variance are reported separately._ The bundle
and `summary.json` report each of these channels independently per condition, so
the tax curve can be read without any single number conflating content cost,
lookup, addressing, and caching.
