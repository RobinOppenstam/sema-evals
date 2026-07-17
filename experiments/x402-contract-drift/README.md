# x402 payment-contract drift

RESEARCH_PLAN parallel infrastructure track. This experiment builds a
**deterministic payer–seller demo** that measures silent payment under
payment-contract drift in the x402 protocol, and distinguishes voluntary
detection from enforced refusal — depending only on whether x402's V2
extension mechanism is honored.

## Evidence role

This is **mechanism validation** for an x402-shaped payment flow. The
deterministic harness validates the in-repo wire model, drift checks, and
fail-closed transition. Real-SDK, facilitator, transport, and chain conformance
remain separate future gates; no workflow-utility or live-payment claim follows
from this demo.

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

The x402 wire shapes are modelled faithfully in-repo as typed zod schemas
rather than pulled from an external SDK — determinism and dependency-lightness
win, and real-SDK conformance testing is future work (see
[ADR 0016](../../docs/adr/0016-x402-contract-drift-design.md)). These are
**in-repo models, not conformance artifacts**.

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

**Model-pilot mode** is not runnable yet. It requires an experiment-specific
payer executor and controlled tool runner; the shared model adapters supply
invocation and telemetry but not the edit/test workflow. See ADR 0016.

`src/model-executor.ts` now defines the thin payer decision contract. It is
paper/historical-replay only, records that no production write was attempted,
and remains blocked by `model-readiness.json` until model configuration and
real-SDK transport conformance are complete.
