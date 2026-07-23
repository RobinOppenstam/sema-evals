# Promoted report: sema-tax / 20260723T073225662Z-size-reuse-order-20260714

- Promoted on: 2026-07-23 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/sema-tax/20260723T073225662Z-size-reuse-order-20260714`
- Mode: deterministic-harness
- Evidence claim: Validates the size/reuse condition grid, per-message and cumulative byte/token accounting, one-time resolver hydration, the size-tier byte bands, scoring, randomization, and reporting only. Deterministic outcomes and token prices are scripted; the token model attributes each definition ingestion once per wire delivery (see ADR 0013).

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
