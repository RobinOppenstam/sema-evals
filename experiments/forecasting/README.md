# Forecasting council

RESEARCH_PLAN Phase 5 scaffold. A **deterministic forecasting-council demo**
that measures corrupted aggregation under coordination-term drift, and
distinguishes voluntary detection from enforced exclusion — depending only on
whether content-addressed references to the coordination substrate are honored.

## Evidence role

This currently provides **mechanism validation** for coordination-term drift
and a **workflow-utility scaffold** for forecasting. Synthetic questions and
scripted probabilities validate aggregation, leakage gating, and scoring; they
do not establish improved forecasting. A utility pilot requires frozen
historical questions acquired under the research plan's dataset gate, followed
by real model runs with mandatory market and independent-agent baselines.

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

Questions are **synthetic** Polymarket-style fixtures (invented events) so CI
stays deterministic. Real Polymarket sourcing and evidence packs are future
work — see [ADR 0017](../../docs/adr/0017-forecasting-council-scaffold.md).

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
- a selected-model, dataset-digest-bound, zero-evidence leakage audit has a
  complete `keep` decision for every included question;
- the configured provider is available and its required credential is present.

The registered first pilot is **no evidence** (ADR 0017), and its loader
rejects every non-null evidence pack. A later evidence-pack arm requires its
own registered validator for licence metadata, retained-byte digests, and
pre-resolution cutoffs; it is not silently enabled here.

Raw Polymarket acquisition and licensed source snapshots belong under the
ignored `datasets/acquired/` directory. Public reports must not publish raw
market content unless redistribution permission is established. Consequently
[`model-readiness.json`](model-readiness.json) correctly remains blocked; no
placeholder data is considered model-ready.

Once an authorized acquisition and audit exist locally:

```bash
pnpm experiment:forecasting -- \
  --mode model-pilot \
  --dataset experiments/forecasting/datasets/acquired/historical-resolved-v1.yaml \
  --leakage-audit experiments/forecasting/datasets/acquired/<model>-leakage-audit.json \
  --provider openai-compatible --base-url https://llm.chutes.ai/v1 \
  --api-key-env CHUTES_API_KEY --model <served-model-id>
```

This produces an exploratory bundle only; it is not confirmatory evidence.
