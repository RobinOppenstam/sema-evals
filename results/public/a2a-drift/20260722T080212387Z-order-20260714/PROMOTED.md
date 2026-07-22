# Promoted report: a2a-drift / 20260722T080212387Z-order-20260714

- Promoted on: 2026-07-22 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/a2a-drift/20260722T080212387Z-order-20260714`
- Mode: deterministic-harness
- Evidence claim: Validates the A2A semantic-extension middleware and two-agent demo: Agent Card extension advertisement, acceptance-contract message parts, controlled cross-agent registry drift, silent execution under baseline, voluntary detection, enforced halt, the no-drift false-halt guard, condition pairing, and bundle/summary reproduction. Scripted-agent outcomes are a construction, not evidence about language models, and not conformance evidence against a real A2A SDK (ADR 0012).

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
