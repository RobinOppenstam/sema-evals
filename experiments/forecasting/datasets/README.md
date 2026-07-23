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

The registered first arm is title-only and no-evidence, so no evidence pack is
needed or accepted. This is a protocol choice, not a missing validator. A later
evidence-pack arm requires separate registration plus retained-byte, license,
and cutoff validation.
