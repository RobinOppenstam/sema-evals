# Promoted report: x402-contract-drift / 20260723T082416781Z-order-20260716

- Promoted on: 2026-07-23 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/x402-contract-drift/20260723T082416781Z-order-20260716`
- Mode: model-pilot
- Evidence claim: Exploratory paper-only model pilot, not confirmatory evidence and not facilitator/on-chain conformance evidence. Only the payer decision is model-driven. Seller, registry drift, verification, enforcement, in-process transport, simulated payload, and settlement remain deterministic. No wallet, signing, network, facilitator, or production write is available.

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
