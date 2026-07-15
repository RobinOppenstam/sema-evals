# ADR 0012: A2A semantic extension design

- Status: accepted
- Date: 2026-07-15

## Context

RESEARCH_PLAN Phase 3 asks for an **extension-compatible middleware prototype
without forking A2A**: Agent Cards that advertise canonicalization and
vocabulary-root support, and task messages that carry required semantic
references and acceptance contracts. The primary endpoint is **silent execution
under cross-agent registry drift**. The exit gate is a two-agent demo that
detects a controlled mismatch under current A2A conventions and distinguishes
voluntary detection from enforced halt.

Phases 1 and 2 built the reusable spine this phase reuses unchanged:
provider-neutral schemas, `planPairedMatrix` / `executeMatrix`, the shared
reference-provider abstraction (`FixtureReferenceProvider` for deterministic
runs, `SemaPythonReferenceProvider` for the official backend), and the generic
`writeResultBundleWith` bundle writer. Phase 1 also taught the discipline this
phase keeps: run the deterministic demo first, because it is this phase's exit
gate.

## Decision

### The extension rides inside A2A's own extension points — literally no fork

"Extension-compatible, no fork" is implemented literally: the Sema extension
uses only A2A's own extension surfaces, and no core A2A message field is ever
repurposed.

- **Agent Card extension descriptor.** The card advertises the extension under
  `capabilities.extensions` as an A2A `AgentExtension`:

  ```json
  {
    "uri": "https://sema-evals.dev/a2a/ext/semantic-canonicalization/v0.1",
    "description": "Content-addressed semantic canonicalization: task acceptance is bound to vocabulary references.",
    "required": false,
    "params": {
      "canonicalizationVersion": "…",
      "vocabularyRoot": "…",
      "backend": "…",
      "enforcement": "voluntary | enforced"
    }
  }
  ```

  `params` advertises the canonicalization version and vocabulary root Phase 3
  asks for, plus the enforcement mode the worker's middleware will apply. A
  baseline card omits the extension entirely.

- **Message-part schema for semantic references + acceptance contracts.** The
  acceptance contract rides in a spec-defined `DataPart` whose `metadata` is
  tagged with the extension URI:

  ```
  DataPart {
    kind: "data",
    data: { acceptanceContract: {
      contractId, extensionUri, enforcement,
      requiredReferences: [ { handle, ref, digest, canonicalizationVersion } ]
    } },
    metadata: { extensionUri: "https://sema-evals.dev/a2a/ext/…/v0.1" }
  }
  ```

  Each required reference is content-addressed (a `ref` bearing the definition
  digest). The A2A `TextPart` carries the actual task and is never used to smuggle
  semantic data; a non-participating agent finds no tagged DataPart and proceeds
  as a plain A2A worker. The A2A task lifecycle (`submitted -> working ->
completed | failed`) is modelled faithfully; enforcement uses the spec's own
  `failed` state with a typed reason.

### Drift-injection design

Each agent holds its own registry (handle → definition). The requester's
registry is the scenario's canonical vocabulary; the worker's registry is the
same vocabulary with, for a drift scenario, exactly one acceptance handle's
definition replaced by a mutated variant. This is the controlled **cross-agent
registry drift**: identical everywhere except the one drifted handle. A
`assertDriftIsolation` guardrail recomputes both registries and fails closed
unless the worker differs from the requester on exactly the drifted handle (or
nowhere, for a no-drift control), so a fixture typo cannot silently widen or void
the drift. The requester addresses the canonical definition; the worker
recomputes the reference from its own (drifted) definition through the same
canonicalization pathway, and the digests diverge — the addressing channel is
what exposes the drift.

### Condition decomposition and what each isolates

Three conditions mirror the Babel Relay enforcement ladder (ADR 0002) where it
maps onto A2A:

- `baseline` — no extension. Task messages carry handle names only; the worker
  resolves them against its own drifted registry and completes. Nothing can
  detect the drift. **Isolates the silent-execution failure mode** (the primary
  endpoint's positive class).
- `advertised-voluntary` — both cards advertise the extension; the message
  carries content-addressed references and an acceptance contract; the worker
  verifies but nothing compels action. The worker surfaces the mismatch and
  still completes. **Isolates voluntary detection** (the value of
  content-addressing on the wire, absent enforcement).
- `advertised-enforced` — identical wire, but the middleware refuses to
  transition the task to `completed` while any required reference mismatches; the
  task fails with a typed reason. **Isolates enforced halt** (the value of a
  compliant, fail-closed runtime).

No-drift controls (scenarios whose `drift` is null) run under all three
conditions on the same scenario/seed blocks via `planPairedMatrix`, so the
false-halt guard is measured on the same pairing. The baseline→voluntary gap is
the detection benefit of content-addressed references; the voluntary→enforced
gap is the benefit of enforcement.

### Endpoints

- **Primary**: silent execution under drift — `driftInjected && !driftDetected`,
  i.e. the worker completed the task using its drifted definition with no
  surfaced mismatch.
- **Secondary**: false halts on no-drift trials (`halted && !driftInjected`).

`driftDetected` and `halted` are recorded as separate metrics so voluntary
detection (detected, not halted) is distinguishable from enforced halt (detected
and task failed). `taskSuccess` is measured against the safety-correct terminal
state for the scenario (`failed` for a drift scenario — drifted work must not
ship; `completed` for a no-drift control), which is why voluntary detection does
not count as task success: the drifted work still shipped.

### No external A2A SDK, and no network — with a future-work note

The A2A wire shapes (Agent Card, capabilities/extensions, messages, typed parts,
task states) are modelled in-repo as typed zod schemas, and the two-agent demo
runs over an in-process transport. We take **no runtime dependency on an
external A2A SDK or any network service**. The reasons match the rest of this
repo: determinism (the deterministic demo is this phase's exit gate and must be
byte-reproducible in CI), dependency-lightness, and the fact that the claims
under test are about the _extension's placement and the middleware's transition
rules_, not about a specific SDK's serialization. The middleware
(`verifyAcceptanceContract` + `applyEnforcement`) is a pure function of an
acceptance contract and a resolving registry, kept cleanly separable from the
demo harness so it can later drop into a real A2A worker unchanged.

**Future work** (noted, not done here): conformance-test the same Agent Card and
message shapes against an official A2A SDK and a real HTTP/JSON-RPC transport,
and add a model-pilot mode that drives real requester/worker agents through the
existing model adapters. Both are out of scope for this PR; no providers are
wired.

### Deterministic-first, and the exit-gate mapping

This phase's exit gate _is_ the deterministic demo, so a model-pilot mode is out
of scope for this PR (recorded above as future work). The scripted agents
exercise every path with exact, test-checked metrics:

| Exit-gate requirement                | Where it is demonstrated                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Two-agent demo                       | `demo.ts` (requester + worker over `transport.ts`)                                                                  |
| Under current A2A conventions        | extension only in `capabilities.extensions` + tagged `DataPart` (`schemas.ts`, `schemas.test.ts`)                   |
| Detects a controlled mismatch        | 100% detection under both advertised conditions; 0% (100% silent) under baseline (`demo.test.ts`, `matrix.test.ts`) |
| Voluntary detection vs enforced halt | voluntary completes with `halted=false`; enforced fails with `halted=true` + typed reason (`demo.test.ts`)          |
| False-halt guard (secondary)         | enforced never halts a no-drift control (`middleware.test.ts`, `matrix.test.ts`)                                    |
| Reproducible evidence                | raw records reproduce the summary; schema-valid bundle (`matrix.test.ts`)                                           |

### Additive reuse of the shared packages

`packages/core`, `packages/adapters`, and `packages/reporters` are unchanged. The
a2a-drift record, metrics, and manifest schemas live in the experiment and
compose core's existing `trialEventSchema`, `trialProvenanceSchema`,
`usageTelemetrySchema`, and `transcriptSchema`. The bundle is written through the
generic `writeResultBundleWith` with the experiment's own record/manifest
schemas, summarizer, and markdown renderer — the same pattern ADR 0010
introduced for the sema-tax curve.

## Consequences

- Phase 3 has a real package with a scripted two-agent demo whose deterministic
  outcomes reproduce every aggregate from raw records, and whose result bundle
  and summary state plainly that they are a construction — not evidence about
  language models and not conformance evidence against a real A2A SDK.
- The extension's placement is testable in isolation: Agent Card extension
  round-trips, tagged-DataPart extraction, drift isolation, the middleware
  transition rules, and the false-halt guard each have unit coverage.
- CI runs no live model and no network: every path is covered by deterministic
  unit tests with the fixture reference backend.
- The next step is a real-SDK/transport conformance pass and a model-pilot mode;
  neither is wired in this PR.
