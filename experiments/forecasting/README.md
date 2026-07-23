# Forecasting council

RESEARCH_PLAN Phase 5 scaffold. A **deterministic forecasting-council demo**
that measures corrupted aggregation under coordination-term drift, and
distinguishes voluntary detection from enforced exclusion — depending only on
whether content-addressed references to the coordination substrate are honored.

## Evidence role

The deterministic mode provides **mechanism validation** for coordination-term
drift. Synthetic questions and scripted probabilities validate aggregation,
leakage gating, and scoring; they do not establish improved forecasting.

The model-pilot path additionally supports an exploratory, real-model replay
over a frozen 50-question historical set. It is still not confirmatory: its
role is to test whether the mechanism remains useful when forecasts are
produced by a model rather than fixture scripts.

## Design

A council of scripted forecasters (default 5) first forecasts independently,
then exchanges structured forecast objects and revises. Each agent resolves
coordination handles against **its own registry**. The experiment injects
controlled **per-agent registry drift**: exactly one forecaster's registry holds
a mutated definition for exactly one coordination handle. Whether that drift
silently corrupts the aggregate, is surfaced, or is excluded depends on the
condition.

Sema aligns the coordination substrate — never beliefs or point estimates:

| Handle                 | Role                                        |
| ---------------------- | ------------------------------------------- |
| `ResolutionDefinition` | What counts as YES / NO                     |
| `EvidenceCutoff`       | Latest time evidence may be used            |
| `ProbabilityFormat`    | Unit interval (0–1) vs percent (0–100)      |
| `AggregationRule`      | Probability mean under canonical formatting |

### Conditions

| Condition             | References on wire | Aggregator verifies | Aggregator enforces    |
| --------------------- | ------------------ | ------------------- | ---------------------- |
| `baseline`            | no (handles only)  | no                  | no                     |
| `addressed-voluntary` | yes                | yes                 | no (aggregate all)     |
| `addressed-enforced`  | yes                | yes                 | yes (exclude mismatch) |

No-drift controls run under all three conditions on the same scenario/seed
blocks, so the false-exclusion guard is measured on the same pairing.

All conditions use the **same canonical numeric interpretation and aggregation
rule**. Addressing may surface a mismatch and enforcement may change inclusion,
but a drifted agent's private registry never repairs its number only in an
addressed arm. Aggregates outside `[0, 1]` are preserved as corrupted raw
outputs; their Brier score is `null` because Brier is defined for probabilities.

- **Primary endpoint**: corrupted aggregation under drift —
  `driftInjected && driftedForecastIncluded && !driftDetected`.
- **Secondary endpoint**: false exclusions on no-drift trials.

Every trial also records **Brier scores** for the council aggregate, the
market-prior baseline (latest available price at or before `forecastCutoff`), and the independent-agent
simple average (round-1, drift-free members).

CI uses **synthetic** Polymarket-style fixtures (invented events) so it stays
deterministic. The operator-local model-pilot dataset is derived from the
CC-BY-4.0 SimpleFunctions Settled Prediction Markets snapshot pinned in
[`datasets/simplefunctions-2026-source-snapshot.json`](datasets/simplefunctions-2026-source-snapshot.json).
It contains 50 unique 2026 markets, balanced 25 YES / 25 NO, each paired as a
drift and no-drift scenario. The first pilot is intentionally title-only and
no-evidence; evidence packs are a separately registered follow-up arm. See
[ADR 0017](../../docs/adr/0017-forecasting-council-scaffold.md).

References are produced through the same canonicalization pathway as the other
experiments (`FixtureReferenceProvider` by default;
`SemaPythonReferenceProvider` compatible via `--semantic-backend sema-python`).

## Run (deterministic harness)

```bash
pnpm experiment:forecasting
pnpm experiment:forecasting -- --seeds 5 --order-seed 20260716

pnpm experiment:forecasting -- \
  --semantic-backend sema-python \
  --sema-python ../sema/.venv/bin/python
```

Deterministic harness outcomes are constructed and must not be presented as
evidence about language models, nor as evidence about live prediction markets.

## Model-pilot readiness (fail closed)

`model-pilot` is wired through the shared `createModelProvider` adapter and
preserves every member transcript, usage record, malformed output, and provider
failure. Forecasts are strictly JSON-parsed and Brier scoring, market-prior,
independent-agent, drift, and exclusion metrics are deterministic; no LLM is a
judge.

It will not run until all of these executable checks pass:

- an operator-acquired, historical resolved-market dataset validates source URL,
  licence metadata, outcome provenance, and a pre-resolution market-prior time;
- every semantic definition uses fields covered by official Sema
  canonicalization and every declared mutation produces a different official
  Sema address;
- a selected-model, dataset-digest-bound, zero-evidence leakage audit passes
  the registered temporal and exact-binomial dataset-level screen;
- the configured provider is available and its required credential is present.

The registered first pilot remains **no evidence** (`no-evidence-v1`; ADR
0017), and its loader rejects every non-null evidence pack. The distinct
`frozen-market-signal-v1` arm is now available only with an explicit
`--information-arm` selection and a dataset whose local evidence bytes validate
for licence, cutoff, digest, path containment, and drift/control-pair equality.
It gives each member the same frozen t−24h source-market YES probability; the
request explicitly asks for YES under that member's local
`ResolutionDefinition`, so the polarity-drift member must invert the signal.
No frozen evidence contains a resolved outcome.

All conditions make independent calls, but the model request has no condition
label and keeps question, local semantic content, and frozen evidence unchanged
across conditions; only forecast-reference carrying/verification/enforcement
differs outside the request. Sampling and provider variation are retained as
trial noise, never attributed to Sema. Provider usage records separate model
input and total model tokens; trial metrics separately retain semantic wire and
hydration bytes plus deduplicated retained evidence bytes.

Raw acquired snapshots and generated model-specific audits belong under the
ignored `datasets/acquired/` directory. The tracked source manifest freezes
upstream revision, attribution, terms snapshot, and every acquired-file hash.
The 50-market evaluation subset is less than 0.1% of the source's 241,133
monthly rows and is not a competing re-host.

Rebuild and audit the frozen local input:

```bash
pnpm forecasting:prepare-dataset
pnpm forecasting:leakage-audit
pnpm forecasting:prepare-evidence-dataset
pnpm forecasting:leakage-audit -- --dataset experiments/forecasting/datasets/acquired/historical-resolved-frozen-market-signal-v1.yaml --output experiments/forecasting/datasets/acquired/frozen-market-signal-leakage-audit.json
```

The audit is blind to outcomes during inference. It requires at least 90%
parse completeness and rejects a dataset when zero-evidence accuracy beats
chance under a one-sided exact binomial test at alpha 0.01. It also requires
the selected upstream model to predate every included 2026 resolution. A
model's self-reported knowledge is retained but is not used as the scorer.

Run the exploratory pilot with official Sema:

```bash
SEMA_VOCABULARY_ROOT=../sema/data/vocabulary \
pnpm experiment:forecasting -- \
  --mode model-pilot \
  --dataset experiments/forecasting/datasets/acquired/historical-resolved-v1.yaml \
  --leakage-audit experiments/forecasting/datasets/acquired/mistral-nemo-2407-leakage-audit.json \
  --provider openai-compatible --base-url https://llm.chutes.ai/v1 \
  --api-key-env CHUTES_API_KEY \
  --model unsloth/Mistral-Nemo-Instruct-2407-TEE \
  --semantic-backend sema-python --sema-python ../sema/.venv/bin/python \
  --max-tokens 512 --concurrency 8
```

This executes 100 paired scenarios × 3 conditions = 300 trials and 3,000 model
calls. It writes a durable partial journal as trials settle and produces an
exploratory bundle only; it is not confirmatory evidence.

The evidence arm requires a newly generated, dataset-bound audit and an
explicit arm flag:

```bash
pnpm experiment:forecasting -- \
  --mode model-pilot \
  --information-arm frozen-market-signal-v1 \
  --dataset experiments/forecasting/datasets/acquired/historical-resolved-frozen-market-signal-v1.yaml \
  --leakage-audit experiments/forecasting/datasets/acquired/frozen-market-signal-leakage-audit.json \
  --pilot-questions 10 \
  --provider openai-compatible --base-url https://llm.chutes.ai/v1 \
  --api-key-env CHUTES_API_KEY --model YOUR_SELECTED_MODEL
```

For a deterministic, recorded small pilot after full dataset and audit
validation, add `--pilot-questions 10`. It selects the first 10 unique frozen
question identities (20 paired scenarios, 60 trials, and 600 member calls) and
records the selected scenario identities in the protocol fingerprint.
