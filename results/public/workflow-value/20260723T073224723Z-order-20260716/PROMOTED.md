# Promoted report: workflow-value / 20260723T073224723Z-order-20260716

- Promoted on: 2026-07-23 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/workflow-value/20260723T073224723Z-order-20260716`
- Mode: deterministic-harness
- Evidence claim: Validates the workflow-value scaffold mechanics only: clearly labelled synthetic seed tasks, hidden executable validators, dev/eval separation, paired randomized conditions, fixed token-budget accounting, semantic delivery channels, repair notice handling, and durable result preservation. Scripted outcomes are not evidence about model performance (ADR 0021).

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
