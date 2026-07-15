# ADR 0010: Sema tax curve experiment design

- Status: accepted
- Date: 2026-07-15

## Context

RESEARCH_PLAN Phase 2 asks a cost question, not a drift question: what does an
agent pay, in total model tokens, to carry more semantic patterns, and how does
that cost trade against task quality? The primary endpoint is **task success per
total model token**, measured while active pattern count varies over
`{0, 2, 4, 8, 12, 16}` and crossed with delivery `{full prose, opaque resolver,
content-addressed resolver}` and cache `{cold hydration, warm cache}`.

Phase 1 (Babel Relay, ADRs 0002–0008) built the reusable spine this phase
reuses unchanged: provider-neutral schemas, `planPairedMatrix` /
`executeMatrix`, the transcript-preserving model adapters (Anthropic and
OpenAI-compatible), bounded concurrency and timeouts, and frozen,
digest-verified prompt snapshots. Phase 1 also taught a discipline this phase
keeps: run the deterministic instrumentation first, because it caught two real
bugs (a malformed-decision scorer gap and a resolver hydration-parity slip)
before any spend.

## Decision

### A worksheet task family that produces a genuine cost/benefit curve

Each scenario is a **worksheet**: a fixed list of items, each naming a pattern
(a compact semantic card of `comparator`, `threshold`, `unit`) and a value, and
asking whether the value satisfies that pattern. Ground truth for an item is the
executable predicate `value <comparator> threshold`.

The **active pattern set** for pattern count N is the first N handles of the
scenario's priority-ordered pool. An item is answerable only when its pattern is
active (its definition was delivered). Worksheet items reference patterns spread
across the pool, so coverage rises with N but with **diminishing marginal
benefit**: each added pattern costs roughly a constant number of definition
tokens, while the number of newly-covered items per added pattern falls. Cost is
therefore approximately linear in N and benefit is concave, so _success per
token_ traces a curve with an interior structure rather than a step — exactly
the shape Phase 2 exists to measure. The count=0 arm is the baseline anchor of
the curve.

The zero-pattern level is encoded as a single `p0-baseline` condition, not six
byte-identical baseline cells: with no patterns there is nothing to deliver and
nothing to hydrate, so delivery and cache are undefined there. This keeps the
baseline sample honest and gives all three delivery curves a shared origin.
The full space is `1 anchor + 5 counts x 3 deliveries x 2 caches = 31`
conditions.

### Pairing across every condition

Every condition runs on the **same scenario/seed blocks**. `planPairedMatrix`
forms one block per (scenario, seed), shuffles block order by the recorded
`orderSeed`, and places all 31 conditions inside each block in a
block-seed-shuffled order. `executeMatrix` starts trials in that planned order
and returns records in planned order regardless of completion order, so the
randomized-order discipline of EXPERIMENT_STANDARD holds and analysis stays
deterministic given the plan. Because the deterministic executor is a pure
function of (scenario, condition), its results are identical across repetition
seeds — its within-condition variance is legitimately zero; run-to-run variance
is a property the model pilot exercises, and it is reported per condition.

### Information parity, and the opaque-ID control

For a given active pattern set, the **resolved-definitions block is byte-
identical across prose, opaque, and content arms and across cold and warm** — it
is rendered with a key-sorted, byte-stable serializer independent of how the
definition arrived. Only the material _above_ that block differs: prose inlines
the definitions, the opaque arm shows a content-free lookup label, and the
content arm shows a content-addressed reference (a digest-bearing id). Tools,
worksheet, output convention, and token budget are held constant; no arm
receives reasoning instructions the others lack.

Per ADR 0002, the **opaque-ID resolver controls for compact lookup**: opaque and
content resolve the identical definitions and pay identical hydration, so any
difference between them is attributable to content-addressing itself — here a
small, constant wire overhead (the digest in the reference), the "addressing
tax." The drift-detection benefit that overhead buys is measured in Phase 1, not
here; Phase 2 prices the overhead.

### Cold vs warm, with hydration recorded separately from wire

Wire and hydration are distinct channels and are recorded as distinct metrics
(`wireBytes`, `hydrationBytes`, `totalContextBytes`):

- **Wire bytes** are what crosses the sender→receiver boundary before hydration:
  the full definitions for prose, only compact references for the resolver arms.
- **Hydration bytes** are what the receiver fetches from the registry to resolve
  references. Prose never hydrates (0). A resolver arm on a **cold** cache
  fetches the full definition bytes; on a **warm** cache the definitions are
  already resident locally, so hydration is 0.

Cache also splits the token account without changing throughput, matching
provider prompt-cache accounting: the cacheable prefix (the definitions block)
contributes to `inputTokens` in both states, but on a warm cache those prefix
tokens are additionally reported as `cachedInputTokensRead` and billed at the
cheaper cached rate. Total model tokens (`inputTokens + outputTokens`, the
primary-endpoint denominator) are therefore cache-agnostic; the cache benefit
surfaces in **cost** and in **hydration bytes**, not in token count. Deterministic
token prices are illustrative constants, labelled as such; model-pilot cost is
whatever the provider reports (or null).

> **Superseded in part by [ADR 0011](0011-provider-cache-observational.md).** The
> first instrumentation run showed that an OpenAI-compatible provider (Chutes)
> caches prompt prefixes automatically across _both_ the cold and warm arms, so
> the claim above that the cache benefit surfaces in cost via
> `cachedInputTokensRead` is **not controlled** in model-pilot mode on that
> provider class. ADR 0011 reclassifies provider cached-token telemetry as
> observational and narrows the controlled cold/warm axis to harness-level
> hydration bytes. The hydration channel and the deterministic simulator's
> accounting (now labelled as modelling an idealized provider) are unaffected.

### An objective, executable scorer with a frozen version

Scoring never uses an LLM judge as the source of truth. The agent must end with
strict `ITEM <id>: yes|no` lines; the scorer parses them (tolerating the
markdown-emphasis variants Phase 1 observed), compares each against the
executable ground-truth predicate, and grades `score = correct / total` with
`taskSuccess = all correct`. A missing or malformed answer is wrong, never
dropped. The scorer version string is frozen at
`sema-tax-worksheet-scorer-v1`; changing the parse rule or ground-truth rule
requires bumping it, exactly as the relay's decision scorer is versioned.

### Deterministic instrumentation before any model pilot

The package ships two executors behind one matrix, one CLI, and one record
schema. The **deterministic** executor scripts a worksheet agent that answers an
item correctly exactly when its pattern is active, exercising every metric
channel — wire bytes, hydration bytes, the cold/warm token split, cost, and
graded quality — with exact, test-checked aggregates and no spend. The
**model-pilot** executor drives the same worksheet through a real model via the
existing adapters, taking token/cost/latency from provider usage while still
measuring the byte channels harness-side, and preserving failed calls as
zero-score records with their transcript. It is launchable with the same flag
shape as Babel Relay (`--provider openai-compatible --base-url … --model …
--repetitions N --concurrency N`) and is the standard two-stage procedure: a
five-repetition instrumentation run to validate mechanics and spend, then at
least 30 repetitions for the first exploratory pilot. Its manifest is labelled
"Exploratory model pilot. Not preregistered, not confirmatory evidence."

### Additive reuse of the shared packages

`packages/core` is unchanged: the tax record and manifest schemas live in the
experiment and compose core's existing provenance, usage, transcript, and event
schemas. The one shared-package change is additive: `packages/reporters` gains a
generic `writeResultBundleWith` that takes an experiment's record/manifest
schemas, summarizer, and markdown renderer; `writeResultBundle` is now a thin,
byte-for-byte-preserving wrapper over it. Babel Relay behaviour is unchanged.

## Consequences

- Phase 2 has a real package with a scripted executor that reproduces every
  aggregate from raw records, and a model-pilot path wired but not yet run.
- The primary endpoint isolates the pattern-count token tax; delivery and cache
  are decomposed into separate wire, hydration, token, and cost channels, so no
  single number conflates content cost, lookup, addressing, and caching.
- CI runs no live model: every executor path is covered by unit tests with fake
  adapters, and model-pilot mode fails fast when the provider key is unset.
- The deterministic harness is a construction, not evidence about language
  models; its bundle and summary say so.
