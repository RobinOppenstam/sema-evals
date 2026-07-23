# Local historical acquisition

`acquired/` is intentionally ignored. Do not commit or promote source
snapshots, model-specific audits, or evidence material until the applicable
source terms permit redistribution.

The model-pilot loader accepts an operator-provided
`acquired/historical-resolved-v1.yaml` only after it validates: resolved
historical provenance; `marketPriorObservedAt <= forecastCutoff <
resolutionTimestamp`; explicit source/terms snapshot hashes; and an explicit
publication/redistribution authorization. The first registered pilot is
no-evidence, so its evidence packs must be `null`. A later evidence-pack arm
needs a separately registered evidence validator.

The registered first model pilot uses the
[SimpleFunctions Settled Prediction Markets](https://huggingface.co/datasets/SimpleFunctions/settled-markets)
dataset under CC-BY-4.0 and SimpleFunctions Terms section 13. The tracked
[`simplefunctions-2026-source-snapshot.json`](simplefunctions-2026-source-snapshot.json)
pins upstream revision, attribution, acquisition time, terms/README bytes, and
the SHA-256 digest of every monthly partition used.

After placing the pinned source bytes in the snapshot's `sourceDirectory`,
reproduce the 50-question balanced subset:

```bash
pnpm forecasting:prepare-dataset
```

The preparation script verifies all source bytes before parsing, selects
exactly 25 YES and 25 NO questions under category diversity caps, uses the
source's t-24h probability as both prior and cutoff timestamp, and emits paired
drift/no-drift scenarios. The generated file is
`acquired/historical-resolved-v1.yaml`.

The registered first arm is title-only and `no-evidence-v1`, so no evidence
pack is accepted. It remains unchanged. The separate
`frozen-market-signal-v1` arm is generated with:

```bash
pnpm forecasting:prepare-evidence-dataset
```

It emits `acquired/historical-resolved-frozen-market-signal-v1.yaml` plus one
ignored, local UTF-8 file per unique market under `acquired/evidence/`. Each
drift/control pair refers to exactly the same SHA-256-checked bytes:
`source_market_yes_probability` and its source `observed_at` at t−24h. Those
files contain neither settlement labels nor resolved outcomes. The loader
requires explicit arm selection, source/license metadata, an exact cutoff,
pre-cutoff source observation/publication timestamps, path containment, exact
file digests, and byte equality across a pair.

For this arm, run a fresh zero-evidence contamination audit against the new
dataset before a model pilot. The audit binds the dataset digest, frozen-evidence
pack fingerprint, and ordered question/resolution identity fingerprint. It does
not reuse a no-evidence audit merely because titles look similar; a documented
rebind is valid only when those identities and all fingerprints match.
