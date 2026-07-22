# Promoted report: x402-contract-drift / 20260722T080235358Z-order-20260716

- Promoted on: 2026-07-22 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `results/x402-contract-drift/20260722T080235358Z-order-20260716`
- Mode: deterministic-harness
- Evidence claim: Validates the x402 V2-shaped payment-contract middleware and payer–seller demo: top-level PaymentRequired semantic extension, CAIP-2 network identifiers, PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers, controlled cross-party registry drift, silent payment under baseline, voluntary detection, enforced refusal, the no-drift false-refusal guard, condition pairing, and bundle/summary reproduction. Scripted-agent outcomes are a construction, not evidence about language models, and not conformance evidence against a real x402 SDK (ADR 0016).

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
