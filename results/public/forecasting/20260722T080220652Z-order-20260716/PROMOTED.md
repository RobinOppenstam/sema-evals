# Promoted report: forecasting / 20260722T080220652Z-order-20260716

- Promoted on: 2026-07-22 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/forecasting/20260722T080220652Z-order-20260716`
- Mode: deterministic-harness
- Evidence claim: Validates the forecasting-council scaffold: synthetic Polymarket-style questions, controlled per-agent registry drift, corrupted aggregation under baseline, voluntary detection, enforced exclusion, Brier baselines (market prior + independent-agent average), the no-drift false-exclusion guard, leakage-audit gate, condition pairing, and bundle/summary reproduction. Scripted-agent outcomes are a construction, not evidence about language models, and not evidence about live prediction markets (ADR 0017).

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
