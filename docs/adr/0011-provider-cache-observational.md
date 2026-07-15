# ADR 0011: Provider cache telemetry is observational, not controlled

- Status: accepted
- Date: 2026-07-15
- Supersedes in part: [ADR 0010](0010-sema-tax-experiment-design.md) (cache section)

## Context

The first real-provider instrumentation run of the Sema tax curve (Phase 2)
completed cleanly: a five-repetition Nemo run of 465 trials through the
OpenAI-compatible provider adapter (Chutes, `--provider openai-compatible`). It
surfaced a measurement finding about the cold/warm cache axis.

ADR 0010 modelled cache as a channel that "splits the token account without
changing throughput, matching provider prompt-cache accounting": on a warm cache
the cacheable prefix tokens are additionally reported as `cachedInputTokensRead`
and billed at the cheaper cached rate, so the cache benefit was claimed to
surface in **cost**. In the deterministic simulator that is exactly true by
construction, because the simulator decides where the prefix is billed.

The instrumentation run showed that on a real OpenAI-compatible provider it is
**not** true as a controlled effect:

- Every one of the 225 warm-arm trials reported `cachedInputTokensRead > 0`
  (from the provider's `prompt_tokens_details.cached_tokens`, mapped in
  [ADR 0007](0007-openai-compatible-provider-adapter.md)).
- But so did **all 225 cold-arm trials**: 225/225 cold trials were also cache-
  contaminated.

Chutes caches prompt prefixes automatically. The harness's cold/warm _condition
label_ does not control the provider's cache — the provider caches whatever
prefix it wants across both arms. The cold arm is therefore contaminated by
provider caching it never asked for, and any cold-vs-warm difference in
`cachedInputTokensRead` (or in provider-reported cost derived from it) is not a
clean measurement of the harness condition on this provider class.

What the cold/warm axis _does_ still control is the harness-level **hydration**
distinction, and that channel is real and unaffected by the provider cache:

- A **cold** resolver arm pays hydration bytes to fetch the full definitions
  from the registry to resolve its compact references.
- A **warm** resolver arm pays zero hydration bytes: the definitions are already
  resident locally.

`hydrationBytes` is computed harness-side, entirely independently of the model
call, so provider caching cannot touch it.

## Decision

1. **Keep the cold/warm axis as the harness-level HYDRATION distinction it
   genuinely controls.** Cold pays hydration bytes to resolve references; warm
   pays zero. This channel is real, measured harness-side, and unaffected by any
   provider cache. It remains a controlled part of the design.

2. **Reclassify provider cached-token telemetry as OBSERVATIONAL.**
   `cachedInputTokensRead` (and provider-reported cost that depends on it) is
   still recorded per trial, unchanged — it is useful to observe what the
   provider actually did. But in model-pilot mode it is **no longer claimed as a
   controlled cost effect** of the cold/warm condition, because the provider
   caches across both arms.

3. **No cache-busting.** We deliberately do **not** inject nonces, randomized
   prefixes, or any other trick to defeat the provider cache. That would break
   information parity between arms and add a confound worse than the one it
   removes. The honest move is to relabel the claim, not to perturb the stimulus.

4. **The deterministic simulator keeps its simulated cache accounting**, but it
   is clearly labelled as simulating an **idealized provider** — one where the
   warm arm reads the cacheable prefix at the cheaper rate and the cold arm does
   not. It exercises the cost pathways with exact, reproducible values; it is not
   a claim about how any specific real provider bills its cache.

## What each mode may and may not claim

|                                                   | Deterministic harness                        | Model pilot (real provider)                                                                  |
| ------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Hydration bytes (cold vs warm)                    | Controlled, exact, test-checked              | Controlled, measured harness-side                                                            |
| Wire bytes, total context bytes                   | Controlled, exact                            | Controlled, measured harness-side                                                            |
| `cachedInputTokensRead`                           | Simulated (idealized provider); illustrative | **Observational only** — provider caches across both arms; not a controlled cold/warm effect |
| Cost (`costUsd`)                                  | Illustrative constants                       | Provider-reported; cache component is observational, not controlled                          |
| Total model tokens (primary-endpoint denominator) | Controlled, exact                            | Provider-reported; cache-agnostic by construction                                            |
| Graded quality / task success                     | Scripted (not evidence about models)         | Real model output, objectively scored                                                        |

## Consequences

- The primary endpoint (task success per total model token) is unchanged:
  `totalModelTokens = inputTokens + outputTokens` is cache-agnostic by
  construction, so the provider-cache finding does not touch it.
- ADR 0010's cache section carries a "superseded in part" note pointing here; its
  body is otherwise unchanged (ADRs are immutable records).
- The model-pilot result bundle's `evidenceClaim`, the deterministic bundle's
  `evidenceClaim`, and the `summary.md` preamble all state that provider
  cached-token telemetry is observational and that deterministic cached-token
  accounting simulates an idealized provider.
- The `summary.md` table keeps its `Mean cached tok` column; the preamble caveat
  now explicitly covers it.
- No schema, scorer, or matrix change was required for this finding: the fix is a
  relabelling of what the existing, unchanged telemetry is allowed to claim.
