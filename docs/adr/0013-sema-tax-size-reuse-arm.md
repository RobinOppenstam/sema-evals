# ADR 0013: Sema tax curve — the size/reuse follow-up arm

- Status: accepted
- Date: 2026-07-15
- Extends: [ADR 0010](0010-sema-tax-experiment-design.md) (tax curve design),
  [ADR 0011](0011-provider-cache-observational.md) (cache is observational)

## Context

The Sema tax curve (ADR 0010) priced the addressing tax at a single definition
size (~100 B cards) used once per trial. The interpretation note published on
the site drew the obvious boundary condition:

> These fixtures sit near the worst case for references — definitions of roughly
> a hundred bytes, used once; the tax should shrink as definitions grow or are
> reused.

That is a prediction, and it is testable. This arm tests it. It adds two new
experimental dimensions, kept **orthogonal** to the original design so the
existing 31-condition arm is untouched and still runnable (`--arm default`):

1. **Definition size** — how many bytes a definition carries.
2. **Reuse R** — how many times a definition is used within one conversation.

The prediction, stated as this arm's hypothesis: **the reference arms' total
semantic bytes and score-per-token approach and then beat prose as size×R grows;
the crossover point is the deliverable measurement.**

## Decision

### The grid: size × reuse × delivery, at fixed p8 cold

Pattern count is held **fixed at p8** — the mid-curve, well-characterized point
of the base curve — so this arm varies only the two new axes and does not
re-open the count axis. The cache axis is **dropped**: per ADR 0011 the
controlled channel is harness-level hydration, and warm adds nothing once
hydration is the thing being amortized. Every cell is cold, so hydration is
always paid and its one-time-ness under reuse is exactly what we measure.

The condition grid is therefore:

```
3 sizes × 3 reuse factors × 3 deliveries × cold = 27 conditions
```

with ids `p8-{size}-r{R}-{delivery}-cold`, e.g. `p8-medium-r3-content-cold`.

- **size** ∈ `{small, medium, large}`
- **R** ∈ `{1, 3, 9}`
- **delivery** ∈ `{prose, opaque, content}` — the baseline (task-only) arm has
  nothing to size or reuse and is not part of this grid.

The `small × R1` cells are **byte-parity anchors** of the base arm's `p8` cold
cells: small is the base ~100 B core card and R1 is a single message, so
`p8-small-r1-{delivery}-cold` reproduces the wire and hydration bytes of the base
`p8-{delivery}-cold` cell. A test asserts this parity, tying the two arms
together at their shared origin.

### Size tiers: bytes vary, difficulty does not

Size comes from **realistic auxiliary specification content** — constraint
rationale, boundary examples, and edge-case notes as structured fields — attached
to the same scoreable core (`comparator`, `threshold`, `unit`, plus `gloss`). The
tiers are:

| Tier   | Canonical rendered-definition bytes | Content                   |
| ------ | ----------------------------------- | ------------------------- |
| small  | ~100 B (the base card)              | core only                 |
| medium | **900–1200 B**                      | core + `auxiliary.medium` |
| large  | **3500–4500 B**                     | core + `auxiliary.large`  |

The byte target is a **range**, stated here and **enforced by a fixture test**
(and by the fixture loader, which throws on load). "Rendered-definition bytes" is
the definition object serialized with the byte-stable serializer (`utf8Bytes`),
the same measurement the harness uses at render time.

The critical property: **the scorer never reads the auxiliary fields.** Ground
truth for an item is still `value <comparator> threshold`, derived from the core.
The core is byte-identical across all three tiers (a fixture test asserts this),
so **ground truth and difficulty are constant across tiers while bytes vary by
roughly an order of magnitude.** Size isolates _amortization-by-bytes_: at equal
score, a larger definition means the fixed reference overhead is a smaller
fraction of the whole.

Fixtures are a single catalog whose patterns are **parameterized by tier**
(`auxiliary: { medium, large }` on the same handle), not tier-suffixed handles.
Justification: the scoreable core must be provably the same object across tiers,
and a shared handle with a tier selector makes that structural rather than a
naming convention that a test has to police. The `small` tier is the core alone,
so it stores no auxiliary.

### Reuse R: the R-message conversation shape

A trial becomes **R sequential worksheet messages in one conversation** with a
fixed system prompt (the frozen worksheet-solver). Each message is a **full
worksheet** — the same worksheet, reusing the same definitions — so R models
_reuse of the definitions across repeated tasks_.

The delivery arms differ in what reuse costs, which is the whole point:

- **Prose** carries no registry, so it must re-ship the full definitions **in
  every message** — that is how prose travels between parties. Wire scales ∝ R.
- **Resolver arms (opaque, content)** carry compact references **every message**
  (wire ∝ R, but tiny), and **hydrate the definitions once** — the first
  resolution, on the cold first message. Later messages reference the
  already-resident definitions. Hydration is **constant in R**.

Telemetry is recorded **per message and cumulatively**: each message records its
`wireBytes`, `hydrationBytes`, `totalContextBytes`, `inputTokens`,
`outputTokens`, and its own worksheet score/item counts; the trial rolls these up
into `cumulativeWireBytes`, `cumulativeHydrationBytes`, `totalSemanticBytes`
(wire + hydration), `totalInputTokens`, `totalOutputTokens`, `totalModelTokens`,
and summed item counts. **Scoring:** each message is scored as a full worksheet;
the **trial score is the mean across the R messages**, and `itemsAnswered` /
`itemsCorrect` / `itemsTotal` are summed across messages. `taskSuccess` requires
every message fully correct.

### What each comparison isolates

- **size** (holding R, delivery): amortization-by-bytes. The reference overhead
  (a digest or lookup label plus one hydration) is fixed; a bigger definition
  makes it a smaller share.
- **R** (holding size, delivery): amortization-by-repetition. Prose pays the
  definitions R times; a resolver arm pays them once and references them R times.
- **their interaction** (the size × R grid, per delivery): the **crossover
  surface**. Prose's total semantic bytes grow like `R × (definition size)`; a
  resolver arm's grow like `(definition size) + R × (reference size)`. The
  surface where content crosses prose — on total semantic bytes and on
  score-per-token — is the deliverable measurement. The summary computes it
  explicitly as a `crossings` table (prose vs content per size × R, with
  `contentBeatsProse{Bytes,Tokens}` flags).

### Endpoints

Two primary endpoints, each as a function of **size × R per delivery**:

1. **score per total model token** — `score / totalModelTokens`, the base curve's
   denominator, carried forward.
2. **score per total semantic byte** — `score / totalSemanticBytes` (wire +
   hydration). This is the channel where reference reuse amortizes, and where the
   published prediction is most directly falsifiable.

The summary reports both per condition (`scorePerKToken`, `scorePerKSemanticByte`)
plus the raw cumulative channels, so a downstream analysis can locate the
crossover without re-deriving it.

### The deterministic token model, stated explicitly

Semantic bytes (wire + hydration) are computed **harness-side**, independently of
any model, so their R-amortization is exact and controlled. Tokens need a stated
model. The deterministic harness attributes **each definition ingestion once per
wire delivery**: prose ingests the definitions on every message (R times); a
resolver arm ingests them on the hydrating first message only (once), and later
messages carry references but not the re-inlined definitions.

This is a deliberate abstraction. It models the semantic claim — "the definitions
cross into the model's working context R times for prose, once for resolvers" —
and it deliberately **does not** model provider-specific conversation-history
re-billing (where every prior turn is re-charged each turn) or provider prompt
caching (which would make the re-billed prefix cheap). Those are real, but they
are provider behaviours, and per ADR 0011 provider cache telemetry is
**observational, not controlled**. The model-pilot path drives a real growing
multi-turn conversation and records whatever tokens and cost the provider
reports; it is wired but is not the source of the controlled byte measurement.

### Deterministic-first

Exactly as ADR 0010: the arm ships two executors behind one condition grid, one
CLI flag (`--arm size-reuse`), and one record schema. The **deterministic**
executor scripts the same active-set worksheet agent as the base arm (an item is
answered correctly iff its pattern is in the active set) across the R messages,
exercising every metric channel — per-message wire, one-time hydration,
per-message tokens, the cumulative rollup, cost, and graded quality — with exact,
test-checked values and no spend. The **model-pilot** executor drives the same
R-message conversation through a real model via the existing adapters, taking
token/cost/latency from provider usage while still measuring the byte channels
harness-side, and preserving failed calls as zero-score records with their
transcript. Model-pilot is **wired but not run** in this change.

### Additive reuse of the shared packages

`packages/core`, `packages/adapters`, and `packages/reporters` are **unchanged**.
The arm's record and manifest schemas live in the experiment and compose core's
existing event, provenance, usage, and transcript schemas; the bundle is written
through the existing generic `writeResultBundleWith` with the arm's own schemas,
summarizer, and renderer. The base arm's modules (`conditions`, `context`,
`scorer`, `tax`, `summary`, `schemas`) are untouched and re-used where shared
(delivery policy, the executable scorer, the deterministic simulator, the token
estimator, the byte-stable serializer). The bundle carries its own **distinct
fixture digest** (a separate `worksheets-size-reuse.yaml`), so the two arms'
provenance never collide.

## Consequences

- The published prediction is now a measured surface. In the deterministic
  construction the crossover is visible and reproducible: at `small × R1` (the
  published worst case) prose is cheapest; content overtakes prose on total
  semantic bytes from `medium × R3` onward and decisively at `large × R9`
  (content ~40 KB vs prose ~262 KB), with the same ordering on tokens.
- The two arms share an origin: `small × R1` is byte-parity with the base `p8`
  cold cells, asserted by a test.
- CI runs no live model. Every executor path is covered by unit tests with the
  fixture reference provider; model-pilot mode fails fast when the provider key
  is unset.

## What is NOT claimed

- **No cross-model claims.** The deterministic arm is a construction, not
  evidence about language models; its bundle and summary say so. The model-pilot
  path is exploratory, not preregistered, not confirmatory.
- **Provider cache is observational**, per ADR 0011. The controlled byte channels
  (wire, hydration, total semantic bytes) are harness-side and independent of any
  provider cache; provider `cachedInputTokensRead` and provider-reported cost are
  recorded but not claimed as controlled effects.
- **The deterministic token model is a stated abstraction**, not a claim about
  how any specific provider bills a multi-turn conversation. The controlled,
  exact measurement is the semantic-byte channel; tokens in deterministic mode
  are illustrative and follow the once-per-wire-delivery ingestion model above.
- **The crossover point is fixture-relative.** It depends on the chosen tier byte
  bands and reference sizes; the arm measures _where_ the crossover falls for
  these fixtures and reference backend, not a universal threshold.
