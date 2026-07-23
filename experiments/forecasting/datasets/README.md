# Local historical acquisition

`acquired/` is intentionally ignored. Do not commit or promote raw Polymarket
question text, criteria, market snapshots, CLOB history, or evidence material
until the applicable source terms permit redistribution.

The model-pilot loader accepts an operator-provided
`acquired/historical-resolved-v1.yaml` only after it validates: resolved
historical provenance; `marketPriorObservedAt <= forecastCutoff <
resolutionTimestamp`; explicit source/terms snapshot hashes; and an explicit
publication/redistribution authorization. The first registered pilot is
no-evidence, so its evidence packs must be `null`. A later evidence-pack arm
needs a separately registered evidence validator.

Acquire the candidate set from closed, one-market, non-sports/non-neg-risk
Polymarket Gamma records, and derive each market prior from the latest YES CLOB
price at or before the recorded cutoff. Retain only derived public hashes,
market IDs, and URLs when permission is unclear.
