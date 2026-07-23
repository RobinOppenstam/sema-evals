# Promoted report: forecasting / 20260723T095613198Z-order-20260716

- Promoted on: 2026-07-23 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/forecasting/20260723T095613198Z-order-20260716`
- Mode: model-pilot
- Evidence claim: Exploratory model pilot. Not preregistered, not confirmatory evidence. Historical questions are replayed after a selected-model, zero-evidence leakage audit; model outputs are objectively JSON-parsed and scored against frozen outcomes. The pre-existing primary endpoint remains corrupted aggregation under controlled registry drift; Brier score is reported as the registered utility metric with mandatory market-prior and independent-agent baselines.

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
