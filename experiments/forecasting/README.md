# Forecasting council

RESEARCH_PLAN Phase 5 scaffold. A **deterministic forecasting-council demo**
that measures corrupted aggregation under coordination-term drift, and
distinguishes voluntary detection from enforced exclusion — depending only on
whether content-addressed references to the coordination substrate are honored.

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
| `AggregationRule`      | Probability mean after format normalization |

### Conditions

| Condition             | References on wire | Aggregator verifies | Aggregator enforces    |
| --------------------- | ------------------ | ------------------- | ---------------------- |
| `baseline`            | no (handles only)  | no                  | no                     |
| `addressed-voluntary` | yes                | yes                 | no (aggregate all)     |
| `addressed-enforced`  | yes                | yes                 | yes (exclude mismatch) |

No-drift controls run under all three conditions on the same scenario/seed
blocks, so the false-exclusion guard is measured on the same pairing.

- **Primary endpoint**: corrupted aggregation under drift —
  `driftInjected && driftedForecastIncluded && !driftDetected`.
- **Secondary endpoint**: false exclusions on no-drift trials.

Every trial also records **Brier scores** for the council aggregate, the
market-prior baseline (final pre-resolution price), and the independent-agent
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

**Model-pilot mode**, real Polymarket sourcing, and the evidence-pack arm are
future work; see ADR 0017.
