# Preregistration 001: Babel Relay confirmatory experiment

- Status: draft (registration occurs at the merge commit of this document into
  `main`; that commit hash is the registration timestamp)
- Registered: (filled by the merge commit)
- Run deadline: within 7 days of registration; a run after the deadline
  requires a new preregistration
- Authors: Robin Oppenstam (approval), Claude (drafting, orchestration)

This document follows the "Before running" checklist of
[EXPERIMENT_STANDARD](../EXPERIMENT_STANDARD.md). Everything below is fixed
before the run. Deviations of any kind must be reported in the published
result and disqualify the run from confirmatory status.

## 1. Background and evidence to date

Two exploratory model pilots (Mistral-Nemo-Instruct-2407, 900 trials,
2026-07-14; MiniMax-M2.5, 900 trials, 2026-07-15 — both published at
`results/public/babel-relay/`) showed a consistent mechanism decomposition:
baseline silent divergence above 90% for both models, zero silent divergence
in both addressed arms, and an enforcement gap of +45.0 (Nemo) and +38.9
(MiniMax) percentage points of task success over voluntary checking. These
pilots generated the hypotheses below; they are not confirmatory evidence for
them. This experiment is the one-shot confirmatory test.

## 2. Hypotheses and predicted direction

All hypotheses are evaluated **per model**, independently. The experiment-level
claim ("confirmed") requires every hypothesis to hold for every model. All
confidence intervals are reported regardless of outcome. There is no interim
analysis and no data-dependent stopping.

- **H1 (addressing detects drift).** In each addressed arm
  (`addressed-voluntary`, `addressed-enforced`), the silent-divergence rate
  over that arm's 120 drift trials has a 95% Clopper–Pearson upper bound
  ≤ 5%. (Operationally: at most 1 silent divergence per arm; 2 or more
  fails.) Predicted direction: near zero, as in both pilots.
- **H2 (enforcement converts detection into outcomes).** The difference in
  task-success rate, `addressed-enforced` minus `addressed-voluntary`
  (180 trials per arm), has a 95% Newcombe hybrid-score lower bound > 15
  percentage points. Predicted direction: positive, large (pilots: +39 to
  +45).
- **H3 (the baseline problem is real).** Baseline silent divergence over 120
  drift trials has a 95% Wilson lower bound > 50%. Predicted direction: high
  (pilots: 91.6%–96.7%).

Secondary, descriptive only (no pass/fail): content effect
(`equal-prose` − `baseline` task success), lookup effect
(`opaque-resolver` − `equal-prose`), detection-alone effect
(`addressed-voluntary` − `equal-prose`), false-halt rates per arm, all with
95% Newcombe/Wilson intervals.

## 3. Primary endpoint

Silent semantic divergence rate (drift trials in which no agent surfaced the
injected drift and the relay proceeded), per condition, as computed by the
frozen deterministic scorer. Secondary endpoint: task-success rate per
condition. Both are already computed by the harness summarizer and recomputed
from the public trial derivative at site build time.

## 4. Experimental unit, pairing, and randomization

- Unit: one relay trial (scenario × condition × seed).
- Pairing: all five conditions run on identical scenario/seed blocks
  (`planPairedMatrix`), 6 scenarios × 30 seeds (0–29) × 5 conditions = 900
  trials per model.
- Order: shuffled by the recorded order seed **20260716** (fresh — not used by
  any prior run; pilots used 20260714).
- Models are independent arms of the same design; each model's 900 trials use
  the same blocks and order seed.

## 5. Conditions and the effect isolated by each comparison

Unchanged from the pilots and ADR 0002: `baseline` (floor),
`equal-prose` (content alone), `opaque-resolver` (compact lookup control),
`addressed-voluntary` (detection without compulsion),
`addressed-enforced` (enforcement). H1 uses the addressed arms; H2 isolates
enforcement from detection; H3 characterizes the floor.

## 6. Models and provider (pinned)

Via `--provider openai-compatible --base-url https://llm.chutes.ai/v1`,
concurrency 10 per arm, max-tokens 4096, sampling parameters exactly the CLI
defaults at the registered implementation commit (recorded in each bundle
manifest):

1. `unsloth/Mistral-Nemo-Instruct-2407-TEE` (weak anchor; characterized in 2
   pilot runs)
2. `MiniMaxAI/MiniMax-M2.5-TEE` (strong anchor; characterized in 1 clean
   pilot; the rate-limit-poisoned run `20260715T043712326Z` is quarantined and
   was never promoted)
3. `Qwen/Qwen3-32B-TEE` (third model family; smoke-tested 6/6 format and
   verdict compliance 2026-07-15; no prior babel-relay run — included to test
   generality beyond characterized models)

Arms may run in parallel (distinct provider chutes) or sequentially; each arm
is one uninterrupted run. Excluded models and reasons: gemma-4-31B-turbo
(provider capacity instability), DeepSeek-V3.2 (52–115 s/call on this
provider), default-thinking models (structurally incompatible with the frozen
DECISION-line format; they would measure truncation, not drift).

## 7. Frozen artifacts (registration pins)

- Fixture digest: `a8dcdc8d29395b62cfac17b69895b0c71f76f977e3d3c3ccca4a2f9166d97e2c`
- Prompt digest: `5f8976a6e93d1816dbd1341d5b906df443692e6c81b3ffe2f97e273f394aa99d`
- Scorer version: `decision-parser-v2-markdown-tolerant`
- Sema version 0.3.0; canonicalization v2; vocabulary root
  `6bb456b3062d94ec02f0a7a53ca8a0b3aefba78f24140d0129bd6da86553b070`
- Semantic backend: `semahash-python-workspace-api` (official handshakes,
  ADR 0004)
- Implementation: the registration merge commit itself. The run MUST execute
  from a **clean tree** at that commit or a descendant that does not modify
  `experiments/babel-relay/`, `packages/`, or the pinned fixtures/prompts
  (site-only and docs-only commits are permitted). A `+dirty` marker in any
  bundle manifest disqualifies the run.

If any recorded digest differs at run time from the values above, the run is
void before unblinding any aggregate.

## 8. Sample size and power

900 trials per model (30 repetitions), fixed in advance; no interim looks.
This is deliberately overpowered — with pilot effect sizes, conventional power
targets would need roughly 35–60 trials per arm; at 180 per arm the power for
H2 exceeds 99% under conservative variance (worst-case p = 0.5 gives a CI
half-width of ~10.3 points; the observed pilot gaps exceed the 15-point margin
by ~24–30 points). The larger n is chosen for per-scenario interval precision
and headroom against the exclusion rule, and is declared here so it cannot be
read as post-hoc n-hunting.

## 9. Exclusions and failure handling

- A trial in which any hop exhausts provider retries (recorded
  `hopFailed: true`) is excluded from endpoint analysis and reported in full
  (count and per-condition breakdown) in the published bundle.
- If excluded trials exceed **2% of an arm's trials (>18 of 900)**, that model
  arm is infrastructure-invalid: the whole arm is rerun from scratch under
  this same preregistration, and BOTH bundles are published (the invalid one
  flagged, never silently discarded). Pilot reference point: 0.8% at
  concurrency 10.
- False halts are an endpoint, never an exclusion.
- Malformed model outputs are scored by the frozen parser as-is (a missing or
  malformed DECISION line is a failure, never dropped) — unchanged from the
  pilots.

## 10. Budgets

3 hops per trial maximum (fixed by the relay design); max-tokens 4096 per
hop; estimated cost ≤ $15 total across all three arms; no tool use; no
retries beyond the provider adapter's standard policy (ADR 0008), which is
part of the pinned implementation.

## 11. Analysis method

Computed from the published trial records by the existing summarizer plus the
interval formulas named in §2 (Clopper–Pearson exact for H1; Newcombe
hybrid-score for the H2 difference; Wilson for H3). The analysis script is
part of the registered commit. Conjunctive confirmation logic (all hypotheses,
all models) with every interval reported means no multiplicity correction can
manufacture a pass; a partial result (e.g., 2 of 3 models confirm) is reported
as exactly that, not as confirmation.

## 12. Publication commitment

The result is published to `results/public/` and the site regardless of
outcome — confirmed, partial, or refuted — with mode `confirmatory` and this
document's digest in provenance. The interpretation note is updated in the
same commit (coverage gate). If any H fails, the headline of the published
interpretation states which and by how much, before anything else.
