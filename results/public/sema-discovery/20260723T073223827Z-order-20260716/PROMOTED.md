# Promoted report: sema-discovery / 20260723T073223827Z-order-20260716

- Promoted on: 2026-07-23 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/sema-discovery/20260723T073223827Z-order-20260716`
- Mode: deterministic-harness
- Evidence claim: Deterministic mechanism/scaffold validation of search, selection, dependency resolution, execution, and within-session reuse. Scripted outcomes are constructed and are not evidence that models discover useful patterns or that a library improves workflow performance.

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
