# Promoted report: security / 20260722T080228609Z-order-20260716

- Promoted on: 2026-07-22 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/security/20260722T080228609Z-order-20260716`
- Mode: instrumentation
- Evidence claim: Validates the security fixture catalog, train/heldout leakage guard, condition ladder, deterministic scorer, enforced-decision gate, randomization, and bundle/summary reproduction. Scripted-auditor outcomes are a construction, not evidence about language models (ADR 0014).

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
