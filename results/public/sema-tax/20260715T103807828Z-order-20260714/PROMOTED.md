# Promoted report: sema-tax / 20260715T103807828Z-order-20260714

- Promoted on: 2026-07-15 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/sema-tax/20260715T103807828Z-order-20260714`
- Mode: model-pilot
- Evidence claim: Exploratory model pilot. Not preregistered, not confirmatory evidence. Provider cached-token telemetry is observational only: the cold/warm axis controls harness-level hydration bytes, not the provider's automatic prompt-prefix caching, which may be active in both arms (see ADR 0011).

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
