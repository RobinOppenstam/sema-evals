# A2A semantic extension (drift)

RESEARCH_PLAN Phase 3. This experiment builds an **extension-compatible
middleware prototype without forking A2A** and demonstrates, with a two-agent
deterministic demo, that the Sema semantic extension turns _silent execution
under cross-agent registry drift_ into either voluntary detection or an enforced
halt — depending only on which A2A extension point is honored.

## Evidence role

This is **mechanism validation** for an A2A-shaped semantic extension. It shows
that the in-repo middleware can detect and enforce against controlled registry
drift. It is not conformance evidence against an official A2A SDK or HTTP
transport, and its deterministic agents are not evidence of workflow utility.
The model-pilot arm is exploratory evidence about the named worker setup only.

## Design

Two agents — a requester and a worker — exchange A2A-shaped task messages through
an in-process transport. Each agent resolves pattern handles against **its own
registry**. The experiment injects controlled **cross-agent registry drift**:
the worker's registry holds a mutated definition for exactly one acceptance
handle. Whether that drift is silent, surfaced, or blocked depends on the
condition.

### The extension rides in A2A's own extension points (no fork)

- **Agent Card**: the semantic extension is advertised under
  `capabilities.extensions` as an `AgentExtension` with our URI
  (`https://sema-evals.dev/a2a/ext/semantic-canonicalization/v0.1`) and `params`
  carrying the canonicalization version, vocabulary root, backend, and
  enforcement mode. Baseline cards omit it entirely.
- **Task message**: the acceptance contract (content-addressed references for the
  required handles) rides in a spec-defined `DataPart`, tagged in its `metadata`
  with the extension URI. The A2A `TextPart` (the actual task) is never
  repurposed; a non-participating agent simply ignores the tagged DataPart.
- **Task lifecycle**: `submitted -> working -> completed | failed`. Enforcement
  transitions a drifted task to `failed` with the typed reason
  `semantic-reference-mismatch`.

The A2A wire shapes are modelled faithfully in-repo as typed zod schemas rather
than pulled from an external SDK — determinism and dependency-lightness win, and
real-SDK conformance testing is future work (see
[ADR 0012](../../docs/adr/0012-a2a-semantic-extension-design.md)). The
`middleware.ts` prototype (verification + enforcement) is kept cleanly separable
from the demo harness (transport + scripted agents) so it can later drop into a
real A2A worker unchanged.

### Conditions

Mirroring the Babel Relay enforcement decomposition (ADR 0002) where it maps
onto A2A:

| Condition              | Cards advertise | Message carries                  | Worker verifies | Middleware enforces |
| ---------------------- | --------------- | -------------------------------- | --------------- | ------------------- |
| `baseline`             | no              | handle names only                | no              | no                  |
| `advertised-voluntary` | yes             | references + acceptance contract | yes             | no                  |
| `advertised-enforced`  | yes             | references + acceptance contract | yes             | yes                 |

No-drift controls (scenarios whose `drift` is null) run under all three
conditions on the same scenario/seed blocks, so the false-halt guard is measured
on the same pairing.

- **Primary endpoint**: silent execution under drift — the worker completes the
  task using its drifted definition with no surfaced mismatch
  (`driftInjected && !driftDetected`).
- **Secondary endpoint**: false halts on no-drift trials.

References are produced through the same canonicalization pathway as the other
experiments (`FixtureReferenceProvider` by default;
`SemaPythonReferenceProvider` compatible via `--semantic-backend sema-python`).

## Run (deterministic harness)

```bash
pnpm experiment:a2a
pnpm experiment:a2a -- --seeds 5 --order-seed 20260714

pnpm experiment:a2a -- \
  --semantic-backend sema-python \
  --sema-python ../sema/.venv/bin/python
```

## Run (model-pilot)

Only the **worker** is model-driven. Requester, transport, registries, drift
injection, and middleware stay deterministic. Ground-truth `driftDetected` is
always the middleware digest comparison; the model's `DECISION: proceed|halt`
line measures whether a model worker acts on voluntary detection. See
[ADR 0015](../../docs/adr/0015-a2a-model-pilot-mode.md).

```bash
pnpm experiment:a2a -- \
  --mode model-pilot \
  --model claude-sonnet-5 \
  --repetitions 5

pnpm experiment:a2a -- \
  --mode model-pilot \
  --provider openai-compatible \
  --base-url https://llm.chutes.ai/v1 \
  --model org/model \
  --concurrency 4 \
  --repetitions 5
```

The same command also accepts `claude-code`, `codex-cli`, `grok-build`,
`cursor-agent`, or `opencode` through ambient subscription authentication:

```bash
pnpm experiment:a2a -- \
  --mode model-pilot \
  --provider codex-cli \
  --model gpt-5.6 \
  --repetitions 5
```

API providers require their selected key env var (`ANTHROPIC_API_KEY` or
`CHUTES_API_KEY` by default). Subscription harnesses accept
`--harness-bin`/`--harness-cwd` and record the exact CLI version and harness
controls. Outcomes are exploratory and must not be presented as confirmatory
evidence. See
[ADR 0019](../../docs/adr/0019-subscription-cli-harness-adapters.md).

Deterministic harness outcomes are constructed and must not be presented as
evidence about language models, nor as conformance evidence against a real A2A
SDK.

## Phase 3 exit-gate checklist

> Exit gate: _a two-agent demo detects a controlled mismatch under current A2A
> conventions and distinguishes voluntary detection from enforced halt._

- [x] **Two-agent demo.** A requester and a worker exchange A2A task messages
      through an in-process transport (`transport.ts`, `agents.ts`, `demo.ts`).
- [x] **Under current A2A conventions.** The extension rides only in
      `AgentCard.capabilities.extensions` and a tagged `DataPart`; no core A2A
      field is repurposed (`schemas.ts`, verified by `schemas.test.ts`).
- [x] **Controlled mismatch.** Cross-agent registry drift mutates exactly one
      acceptance handle on the worker side, guarded by `assertDriftIsolation`
      (`registry.ts`, `drift.test.ts`).
- [x] **Detects the mismatch.** `advertised-voluntary` and `advertised-enforced`
      both reach 100% detection over drift trials; `baseline` reaches 0%
      (100% silent execution) — the primary endpoint (`demo.test.ts`,
      `matrix.test.ts`).
- [x] **Distinguishes voluntary detection from enforced halt.** Voluntary
      detects and surfaces the mismatch but still completes the task
      (`halted=false`, `finalTaskState=completed`); enforced detects **and**
      fails the task (`halted=true`, `finalTaskState=failed`, typed reason).
- [x] **False-halt guard.** `advertised-enforced` never halts a no-drift control
      (`falseHalts=0`), the secondary endpoint (`middleware.test.ts`,
      `demo.test.ts`, `matrix.test.ts`).
- [x] **Reproducible evidence.** Raw trial records reproduce the aggregate
      summary; the bundle is schema-valid (`matrix.test.ts`).

## What the demo demonstrates

| Condition              | Drift trial outcome                                     | No-drift control outcome                |
| ---------------------- | ------------------------------------------------------- | --------------------------------------- |
| `baseline`             | completes silently with drifted work (silent execution) | completes correctly                     |
| `advertised-voluntary` | mismatch detected + surfaced, task still completes      | completes correctly, no false detection |
| `advertised-enforced`  | mismatch detected, task **fails** (typed reason)        | completes correctly, **no false halt**  |

The gap between `baseline` (silent) and `advertised-voluntary` (detected) is the
value of content-addressed references under A2A. The gap between
`advertised-voluntary` (detected, still ships) and `advertised-enforced`
(detected, halted) is the value of a compliant, fail-closed runtime — exactly
the content/addressing/enforcement decomposition the research plan requires.
