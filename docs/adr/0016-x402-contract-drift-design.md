# ADR 0016: x402 payment-contract drift design

- Status: accepted
- Date: 2026-07-16

## Context

RESEARCH_PLAN's parallel infrastructure track asks for **x402 payment-contract
drift fixtures**: a deterministic experiment measuring silent payment under
payment-contract drift in the x402 protocol (Coinbase's HTTP 402 payment flow
for agents). The claim under test mirrors ADR 0012 (A2A semantic extension): a
payer and a seller each hold their own registry of payment-term definitions
(what "settlement finality", "refund window", "amount basis", etc. mean). When
one side's definition has drifted, a payer that resolves terms by handle name
pays under a contract it misunderstands — silently. Content-addressed
references expose the drift; enforcement refuses to emit a payment payload
under a mismatched reference.

Phases 1–3 built the reusable spine this experiment reuses unchanged:
provider-neutral schemas, `planPairedMatrix` / `executeMatrix`, the shared
reference-provider abstraction (`FixtureReferenceProvider` for deterministic
runs, `SemaPythonReferenceProvider` for the official backend), and the generic
`writeResultBundleWith` bundle writer. This experiment is deliberately a sibling
of ADR 0012: same isolation discipline, same voluntary-vs-enforced
decomposition, same deterministic-first exit gate — applied to x402's own
extensibility point instead of A2A's.

## Decision

### The extension rides inside x402's own extensibility point — no core-field fork

"Extension-compatible, no fork" is implemented literally: the Sema extension
uses only x402's own `PaymentRequirements.extra` field, and no core x402 field
(`scheme`, `network`, `asset`, `payTo`, `maxAmountRequired`, `description`,
…) is ever repurposed.

- **402 PaymentRequirementsResponse.** The seller responds with an in-repo
  model of the x402 v1 payment-required payload: `x402Version`, `error`, and
  `accepts[]` of `PaymentRequirements`.

- **Acceptance contract in `extra`.** Under advertised conditions, the chosen
  `PaymentRequirements.extra` carries:

  ```
  {
    contractId, extensionUri, enforcement,
    requiredReferences: [ { handle, ref, digest, canonicalizationVersion } ]
  }
  ```

  Each required reference is content-addressed (a `ref` bearing the definition
  digest) — the same reference shape as a2a-drift. A baseline seller omits
  `extra` entirely. A non-participating payer finds no contract and proceeds as
  a plain x402 client.

- **PaymentPayload and SettlementResponse.** The payer's `X-PAYMENT` content is
  modelled as a typed `PaymentPayload` object; signing is simulated
  deterministically (no real crypto). Settlement is an in-repo
  `SettlementResponse`. Enforcement refuses to emit the `PaymentPayload` while
  any required reference mismatches, with a typed failure reason.

### In-repo models, not conformance artifacts

The x402 wire shapes (`PaymentRequirements`, `PaymentPayload`,
`SettlementResponse`, and the 402 envelope) are modelled in-repo as typed zod
schemas. We take **no runtime dependency on an external x402 SDK, any network
service, or any chain**. These are faithful models of the v1 shapes at the
level that matters for the claim under test — extension placement and payer
middleware transition rules — **not** conformance artifacts against an official
x402 SDK or live facilitator. Document this plainly on every evidence surface
(ADR, README, bundle `evidenceClaim`, summary markdown).

### Drift-injection design

Each party holds its own registry (handle → definition). The seller's registry
is the scenario's canonical vocabulary; the payer's registry is the same
vocabulary with, for a drift scenario, exactly one acceptance handle's
definition replaced by a mutated variant. This is the controlled **cross-party
registry drift**: identical everywhere except the one drifted handle. A
`assertDriftIsolation` guardrail recomputes both registries and fails closed
unless the payer differs from the seller on exactly the drifted handle (or
nowhere, for a no-drift control), so a fixture typo cannot silently widen or
void the drift. The seller addresses the canonical definition in `extra`; the
payer recomputes the reference from its own (drifted) definition through the
same canonicalization pathway, and the digests diverge — the addressing channel
is what exposes the drift.

Fixture ground truth lives **only** in the scenario JSON/TS fixture data (the
`drift` block). Payer-facing text (`description`, resource URL prose) never
carries ground-truth annotations.

### Condition decomposition and what each isolates

Three conditions mirror the Babel Relay / A2A enforcement ladder where it maps
onto x402:

- `baseline` — no extension. Requirements carry prose term names only (in
  description / handle lists); the payer resolves them against its own drifted
  registry and pays. Nothing can detect the drift. **Isolates the silent-
  payment failure mode** (the primary endpoint's positive class).
- `advertised-voluntary` — `extra` carries content-addressed references and an
  acceptance contract; the payer verifies against its own registry, surfaces a
  mismatch, and still pays. **Isolates voluntary detection**.
- `advertised-enforced` — identical wire, but the payment middleware refuses to
  emit the `PaymentPayload` while any required reference mismatches; typed
  failure. **Isolates enforced refusal**.

No-drift controls (scenarios whose `drift` is null) run under all three
conditions on the same scenario/seed blocks via `planPairedMatrix`, so the
false-refusal guard is measured on the same pairing. The baseline→voluntary gap
is the detection benefit of content-addressed references; the voluntary→enforced
gap is the benefit of enforcement.

### Endpoints

- **Primary**: silent payment under drift —
  `driftInjected && paid && !driftDetected`.
- **Secondary**: false refusals on no-drift trials (`halted && !driftInjected`).

`driftDetected`, `paid`, and `halted` are recorded as separate metrics so
voluntary detection (detected, paid, not halted) is distinguishable from
enforced refusal (detected, halted, not paid). `taskSuccess` is measured against
the safety-correct terminal state for the scenario (`refused` for a drift
scenario — payment under a misunderstood contract must not ship; `paid` for a
no-drift control), which is why voluntary detection does not count as task
success: the misunderstood payment still shipped.

### Deterministic-first, and the exit-gate mapping

This experiment's exit gate _is_ the deterministic demo, so a **model-pilot
mode is out of scope for this PR** (recorded as future work below). The
scripted payer and seller exercise every path with exact, test-checked metrics:

| Exit-gate requirement                   | Where it is demonstrated                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Payer + seller demo                     | `demo.ts` (payer + seller over `transport.ts`)                                                                      |
| Under current x402 conventions          | acceptance contract only in `PaymentRequirements.extra` (`schemas.ts`, `schemas.test.ts`)                           |
| Detects a controlled mismatch           | 100% detection under both advertised conditions; 0% (100% silent) under baseline (`demo.test.ts`, `matrix.test.ts`) |
| Voluntary detection vs enforced refusal | voluntary pays with `halted=false`; enforced refuses with `halted=true` + typed reason (`demo.test.ts`)             |
| False-refusal guard (secondary)         | enforced never refuses a no-drift control (`middleware.test.ts`, `matrix.test.ts`)                                  |
| Reproducible evidence                   | raw records reproduce the summary; schema-valid bundle (`matrix.test.ts`)                                           |

### Additive reuse of the shared packages

`packages/core`, `packages/adapters`, and `packages/reporters` are unchanged.
The x402-contract-drift record, metrics, and manifest schemas live in the
experiment and compose core's existing `trialEventSchema`,
`trialProvenanceSchema`, `usageTelemetrySchema`, and `transcriptSchema`. The
bundle is written through the generic `writeResultBundleWith` with the
experiment's own record/manifest schemas, summarizer, and markdown renderer —
the same pattern ADR 0010 introduced and ADR 0012 reused.

### Future work (noted, not done here)

- Conformance-test the same wire shapes against an official x402 SDK and a real
  HTTP transport / facilitator (out of scope; no providers are wired).
- Add a **model-pilot mode** that drives a real payer agent through the existing
  model adapters while seller, transport, registries, drift injection, and
  middleware stay deterministic. Out of scope for this PR.

## Consequences

- The parallel infrastructure track has a real package with a scripted
  payer–seller demo whose deterministic outcomes reproduce every aggregate from
  raw records, and whose result bundle and summary state plainly that they are a
  construction — not evidence about language models and not conformance evidence
  against a real x402 SDK.
- The extension's placement is testable in isolation: `extra` round-trips,
  drift isolation (including fixture-typo fail-closed), the middleware
  transition rules, and the false-refusal guard each have unit coverage.
- CI runs no live model, no network, and no crypto libraries: every path is
  covered by deterministic unit tests with the fixture reference backend.
- The next step is a real-SDK/transport conformance pass and a model-pilot mode;
  neither is wired in this PR.
