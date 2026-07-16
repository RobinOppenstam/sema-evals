# x402 payment-contract drift

RESEARCH_PLAN parallel infrastructure track. This experiment builds a
**deterministic payer–seller demo** that measures silent payment under
payment-contract drift in the x402 protocol, and distinguishes voluntary
detection from enforced refusal — depending only on whether x402's own `extra`
extensibility point is honored.

## Design

A seller and a payer exchange x402-shaped messages through an in-process
transport. Each party resolves payment-term handles against **its own
registry**. The experiment injects controlled **cross-party registry drift**:
the payer's registry holds a mutated definition for exactly one acceptance
handle. Whether that drift is silent, surfaced, or blocked depends on the
condition.

### The extension rides in x402's own extensibility point (no fork)

- **402 PaymentRequirements**: core fields (`scheme`, `network`,
  `maxAmountRequired`, `asset`, `payTo`, `description`, …) are never
  repurposed. Baseline omits `extra` entirely.
- **Acceptance contract in `extra`**: under advertised conditions,
  `PaymentRequirements.extra` carries content-addressed references and an
  acceptance contract (`contractId`, `extensionUri`, `enforcement`,
  `requiredReferences`) — the same reference shape as a2a-drift.
- **PaymentPayload / SettlementResponse**: the payer's X-PAYMENT content is a
  typed object; signing is simulated deterministically (no crypto, no chain).
  Enforcement refuses to emit the payload while any required reference
  mismatches, with the typed reason `semantic-reference-mismatch`.

The x402 wire shapes are modelled faithfully in-repo as typed zod schemas
rather than pulled from an external SDK — determinism and dependency-lightness
win, and real-SDK conformance testing is future work (see
[ADR 0016](../../docs/adr/0016-x402-contract-drift-design.md)). These are
**in-repo models, not conformance artifacts**.

### Conditions

| Condition              | `extra` carries contract | Payer verifies | Middleware enforces |
| ---------------------- | ------------------------ | -------------- | ------------------- |
| `baseline`             | no                       | no             | no                  |
| `advertised-voluntary` | yes                      | yes            | no                  |
| `advertised-enforced`  | yes                      | yes            | yes                 |

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

**Model-pilot mode** (real payer agent via model adapters) is future work; see
ADR 0016.
