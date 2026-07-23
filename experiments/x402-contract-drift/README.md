# x402 payment-contract drift

RESEARCH_PLAN parallel infrastructure track. This experiment builds a
**deterministic payer–seller demo** that measures silent payment under
payment-contract drift in the x402 protocol, and distinguishes voluntary
detection from enforced refusal — depending only on whether x402's V2
extension mechanism is honored.

## Evidence role

This is **mechanism validation** for an x402-shaped payment flow. The
deterministic harness validates the in-repo wire model, drift checks, and
fail-closed transition. A separate pinned-official-SDK fixture validates only
loopback V2 client/header interoperability. Facilitator, settlement, and chain
conformance remain out of scope; no workflow-utility or live-payment claim
follows from this demo.

## Design

A seller and a payer exchange x402-shaped messages through an in-process
transport. Each party resolves payment-term handles against **its own
registry**. The experiment injects controlled **cross-party registry drift**:
the payer's registry holds a mutated definition for exactly one acceptance
handle. Whether that drift is silent, surfaced, or blocked depends on the
condition.

### V2 wire conventions and extension placement (no fork)

- **PaymentRequired** uses `x402Version: 2`, a separate `resource` object,
  `PaymentRequirements.amount`, and CAIP-2 network identifiers.
- **Acceptance contract in `extensions`**: advertised conditions carry the
  content-addressed acceptance contract in the top-level V2 extensions map.
  `PaymentRequirements.extra` remains scheme-specific metadata.
- **HTTP headers**: the in-process transport base64-encodes JSON under
  `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`.
- **PaymentPayload / SettlementResponse**: signing is simulated
  deterministically (no crypto, no chain).
  Enforcement refuses to emit the payload while any required reference
  mismatches, with the typed reason `semantic-reference-mismatch`.

The deterministic wire shapes are modelled in-repo as typed zod schemas. The
separate conformance fixture pins `@x402/core`, `@x402/fetch`, and `@x402/evm`
at `2.19.0`, then runs an ephemeral `127.0.0.1` V2
`PAYMENT-REQUIRED` → `PAYMENT-SIGNATURE` retry → `PAYMENT-RESPONSE` exchange
with an unfunded deterministic key. It checks malformed input, V1 rejection,
and a repeated-402 stop condition. It makes no external request, facilitator
call, RPC call, broadcast, or settlement claim. See
[ADR 0016](../../docs/adr/0016-x402-contract-drift-design.md).

### Conditions

| Condition              | extension carries contract | Payer verifies | Middleware enforces |
| ---------------------- | -------------------------- | -------------- | ------------------- |
| `baseline`             | no                         | no             | no                  |
| `advertised-voluntary` | yes                        | yes            | no                  |
| `advertised-enforced`  | yes                        | yes            | yes                 |

No-drift controls (scenarios whose `drift` is null) run under all three
conditions on the same scenario/seed blocks, so the false-refusal guard is
measured on the same pairing.

- **Primary endpoint**: silent payment under drift —
  `driftInjected && paid && !driftDetected`.
- **Secondary endpoint**: false refusals on no-drift trials.

References are produced through the same canonicalization pathway as the other
experiments (`FixtureReferenceProvider` by default;
`SemaPythonReferenceProvider` compatible via `--semantic-backend sema-python`).
Fixture definitions keep term attributes under Sema's semantic `parameters`
field, and the official-Python integration test fails if any declared mutation
collapses to the canonical Sema address. This is an addressing check; the
TypeScript middleware, not Sema itself, performs the payment halt.

## Run (deterministic harness)

```bash
pnpm experiment:x402
pnpm experiment:x402 -- --seeds 5 --order-seed 20260716

pnpm experiment:x402 -- \
  --semantic-backend sema-python \
  --sema-python ../sema/.venv/bin/python
```

Deterministic harness outcomes are constructed and must not be presented as
evidence about language models, nor as conformance evidence against a real x402
SDK.

## Run (exploratory model pilot)

The model pilot drives only the payer's terminal paper decision. Seller,
registry drift, verification, enforcement, header transport, payload creation,
and settlement simulation remain deterministic. The model has no tools, wallet,
private key, RPC endpoint, facilitator, or production-write path. Every
provider result, including refusal, truncation, error, and malformed JSON, is
recorded with its transcript and usage; it never counts as silent payment.

```bash
pnpm experiment:x402 -- \
  --mode model-pilot \
  --provider openai-compatible \
  --base-url https://llm.chutes.ai/v1 \
  --model <provider-model-id> \
  --repetitions 5
```

For an OpenAI-compatible provider, set `CHUTES_API_KEY` first (or pass
`--api-key-env`). The shared provider surface also supports Anthropic and the
repository's subscription CLI harnesses. The executable localhost conformance
gate runs before provider construction; a failed check prevents every model
call.
