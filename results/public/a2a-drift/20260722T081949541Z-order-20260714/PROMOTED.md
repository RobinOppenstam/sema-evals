# Promoted report: a2a-drift / 20260722T081949541Z-order-20260714

- Promoted on: 2026-07-22 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/a2a-drift/20260722T081949541Z-order-20260714`
- Mode: model-pilot
- Evidence claim: Exploratory model pilot. Not preregistered, not confirmatory evidence. Worker is model-driven; requester, transport, registries, drift injection, and middleware remain deterministic. Ground-truth driftDetected is middleware-only (ADR 0015).

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
