# ADR 0017: forecasting council scaffold

- Status: accepted
- Date: 2026-07-16

## Context

RESEARCH_PLAN Phase 5 asks for a **forecasting council**: agents first
forecast independently, then exchange structured evidence and revise. Sema
aligns the coordination substrate — event resolution definition, evidence
cutoff, probability format, and aggregation rule — never the beliefs or point
estimates themselves.

The Sema-shaped claim under test: two forecasters whose _definitions_ of the
coordination terms have drifted (e.g. "resolves YES if announced by end of Q2"
vs "resolves YES if effective by end of Q2", or probability as a 0–1 decimal vs
0–100 percent) produce forecasts that look aggregatable but are not. Baseline
aggregation silently averages incomparable numbers; content-addressed
references detect the definitional mismatch; enforcement refuses aggregation
until the coordination terms are digest-aligned.

Phases 1–4 built the reusable spine this experiment reuses unchanged:
provider-neutral schemas, `planPairedMatrix` / `executeMatrix`, the shared
reference-provider abstraction (`FixtureReferenceProvider` for deterministic
runs, `SemaPythonReferenceProvider` for the official backend), and the generic
`writeResultBundleWith` bundle writer. This experiment is deliberately a sibling
of ADR 0012 (A2A) and ADR 0016 (x402): same isolation discipline, same
voluntary-vs-enforced decomposition, same deterministic-first exit gate —
applied to a multi-forecaster council instead of a two-party exchange.

## Decision

### Question source is Polymarket (synthetic fixtures for this scaffold)

The project owner decided the question source is **Polymarket**. The question
fixture schema therefore models a resolved Polymarket-style market: question
text, precise resolution criteria text, resolution timestamp, resolved outcome
(YES/NO), and the market's final pre-resolution price as the **market-prior
baseline**.

For **this deterministic scaffold**, all question fixtures are **synthetic**
(invented events, clearly labeled `synthetic-` in scenario ids). Outcomes are
known by construction so CI stays fully deterministic — no network and no live
market API. Real Polymarket sourcing is pilot-time work (see Future work).

### No-evidence variant first

Agents forecast from question text alone. There are **no evidence packs** in
this scaffold: the question schema carries an optional `evidencePack` field
that is `null` throughout, left as a clearly marked extension point. Hand-curated
evidence packs are a follow-up arm (see Future work).

### Coordination vocabulary — four handles

Exactly four coordination handles, each with a definition held in per-agent
registries:

| Handle                 | Role                                        |
| ---------------------- | ------------------------------------------- |
| `ResolutionDefinition` | What counts as YES / NO for the event       |
| `EvidenceCutoff`       | Latest time evidence may be used            |
| `ProbabilityFormat`    | Unit interval (0–1) vs percent (0–100)      |
| `AggregationRule`      | Probability mean after format normalization |

References are produced through the shared reference-provider abstraction
(`FixtureReferenceProvider` default; `--semantic-backend` / `--sema-python`
exactly as sibling CLIs).

### Drift-injection design

A council of N scripted forecasters (default 5). In a drift scenario, exactly
**one** forecaster's registry holds a mutated definition for exactly **one**
coordination handle. An `assertDriftIsolation` guardrail recomputes every
agent's registry and fails closed unless that invariant holds (or nowhere, for
a no-drift control), so a fixture typo cannot silently widen or void the drift.

Two drift families appear in fixtures:

1. **Resolution-definition drift** — the drifted agent is forecasting a
   different event (announced vs effective, etc.).
2. **Probability-format drift** — 0–1 vs 0–100. The number is right under its
   own format and catastrophic when averaged raw. The canonical fixture
   averages a `0.62`-scale council with a raw `62` under baseline and produces
   garbage; that exact arithmetic is test-checked.

Fixture ground truth (outcomes, drift specs, audit verdicts) lives **only** in
fixture data structures. Agent-facing question and definition text never carries
ground-truth annotations.

### Council protocol (scripted, two rounds)

1. **Round 1** — each forecaster produces an independent forecast from the
   question text alone (scripted probability in the fixture).
2. **Round 2** — each agent sees the others' structured forecast objects
   (probability + cited coordination references) and may revise per its script.

Scripted forecast behavior lives in fixtures so every aggregate is exactly
reproducible. No live model calls.

### Condition decomposition

Three conditions, paired via `planPairedMatrix` on the same scenario/seed
blocks:

- `baseline` — coordination terms named by handle only; aggregation proceeds
  blindly (raw mean of reported numbers). Isolates corrupted aggregation under
  drift.
- `addressed-voluntary` — forecast objects carry content-addressed references;
  the aggregator verifies digests and surfaces mismatches but still aggregates
  **all** forecasts (after per-agent format normalization where references
  resolve). Isolates voluntary detection.
- `addressed-enforced` — the aggregator refuses to include any forecast whose
  coordination references mismatch the canonical vocabulary; it aggregates the
  aligned subset and records the exclusion with a typed reason
  (`semantic-reference-mismatch`). Isolates enforced exclusion.

No-drift controls measure false exclusions on the same pairing.

### Endpoints and Brier baselines

- **Primary**: corrupted aggregation under drift — a drifted forecast entered
  the aggregate with no surfaced mismatch
  (`driftInjected && driftedForecastIncluded && !driftDetected`).
- **Secondary**: false exclusions on no-drift controls.

Additionally, every trial records **Brier scores** of:

1. the council aggregate under the condition,
2. the market-prior baseline (final pre-resolution price),
3. the independent-agent simple average (round-1 probabilities of drift-free
   members).

These are the two mandatory baselines from the research plan plus the council
aggregate. With scripted forecasts and synthetic outcomes they are exact numbers
reproducible from raw records; tests assert the summary's Brier values recompute
from the trial records.

### Leakage-audit machinery (no live calls)

Schemas plus a `leakage-audit.json` slot in the result bundle record, per
question, an audit entry `{ model, zeroEvidenceAnswer, confidence, verdict:
keep|drop }` and a summary gate that **fails the run summary** if any included
question lacks an audit entry with verdict `keep`. This is wired so a future
exploratory pilot cannot skip the audit. For the deterministic demo, fixtures
carry synthetic audit entries with `verdict: keep`.

### Deterministic-first

This PR is **scaffold only**: schemas, synthetic fixtures, scripted council
demo, drift injection, Brier scoring with mandatory baselines, leakage-audit
machinery, CLI, and full unit coverage. No live model calls, no network, no
real Polymarket API.

### Additive reuse of the shared packages

`packages/core`, `packages/adapters`, and `packages/reporters` are unchanged.
The forecasting record, metrics, and manifest schemas live in the experiment and
compose core's existing `trialEventSchema`, `trialProvenanceSchema`,
`usageTelemetrySchema`, and `transcriptSchema`. The bundle is written through
the generic `writeResultBundleWith` with the experiment's own
record/manifest schemas, summarizer, and markdown renderer — the same pattern
ADR 0010 introduced and ADRs 0012 / 0016 reused.

### Future work (noted, not done here)

- **Real Polymarket sourcing** — pull resolved historical markets with frozen
  timestamps for an exploratory 50-question pilot (research-plan exit gate).
- **Evidence-pack arm** — populate the optional `evidencePack` field with
  hand-curated, timestamped evidence; agents forecast with evidence then
  exchange structured evidence in round 2.
- **Model-pilot mode** — drive real forecaster agents through the existing
  model adapters while registries, drift injection, aggregation, and leakage
  audit stay deterministic. Out of scope for this PR; no providers are wired.

### 2026-07-23 model-pilot amendment

The model-pilot execution path is now wired, but remains fail-closed until an
authorized historical dataset and a selected-model leakage audit are supplied.
This amendment does not change the registered primary endpoint or promote the
pilot to confirmatory status.

- Historical questions require an explicit `forecastCutoff`, with the market
  prior observed no later than that cutoff and the outcome resolved strictly
  afterward. The model-pilot market baseline is therefore the latest eligible
  market price at or before the cutoff, not a price observed near resolution.
- Because result records retain question and resolution text, every source must
  carry terms-snapshot hashes and explicit publication/redistribution
  authorization. A free-form licence label is insufficient. Raw acquisition
  remains ignored and no Polymarket content is committed while permission is
  unresolved.
- The first pilot remains the registered no-evidence arm and rejects non-null
  evidence packs. A later evidence-pack arm requires a separate registration
  and validator.
- Leakage audits are bound to the exact dataset digest, served model
  descriptor, and registered zero-evidence audit protocol. The validated audit
  artifact, model transcripts, usage, malformed outputs, and provider failures
  are preserved with the run.
- Model trials use the durable result journal so settled trials survive a later
  failure. Aggregation and Brier scoring remain deterministic; no LLM judge is
  introduced.

### 2026-07-23 historical-pilot registration

The first live pilot is now unblocked with a frozen, licensed, model-audited
input. This registration is made before the forecasting calls and does not
change the experiment into confirmatory evidence.

- Source: SimpleFunctions Settled Prediction Markets, revision
  `a27e3e9307266481d51e087fffd5bf934410e01c`, CC-BY-4.0 with attribution to
  SimpleFunctions. The tracked source manifest freezes the terms, README, four
  monthly 2026 partitions, and their SHA-256 digests. Acquired bytes remain
  ignored.
- Sample: 50 unique Polymarket questions resolving March–June 2026, balanced
  25 YES / 25 NO. Eligible priors are 5–95%, categories are capped at four
  questions and two per category/outcome, and high-frequency/noisy market
  families are excluded.
- Pairing: every unique question produces one controlled
  `ResolutionDefinition.parameters.polarity` drift and one aligned control,
  for 100 scenarios. All three conditions run on every scenario, yielding 300
  trials with one seed. Five agents forecast in two rounds, yielding 3,000
  model calls.
- Information arm: title and generic source-outcome resolution rule only.
  `evidencePack` must be null. This is the previously registered no-evidence
  arm; a later evidence-pack study remains separate.
- Selected model: `unsloth/Mistral-Nemo-Instruct-2407-TEE` through the Chutes
  OpenAI-compatible endpoint. The upstream model was released in July 2024;
  all sampled outcomes resolve in 2026.
- Leakage gate: outcomes are hidden for all inference calls. At least 90% of
  unique responses must parse, and a one-sided exact binomial test of
  zero-evidence answer accuracy must not beat chance at alpha 0.01. Model
  self-reports are not a scorer. The frozen audit parsed 49/50 and scored 24/49
  correct (48.98%, p=0.612275), so it passed this screen. This cannot rule out
  all contamination.
- Sema gate: historical definitions may only use fields in official Sema's
  semantic hash surface. Before any forecasting call, every declared mutation
  must resolve to a different official Sema address from the canonical
  definition. A collapse aborts the run.
- Endpoint discipline: the scaffold's pre-existing mechanism endpoint remains
  corrupted aggregation under controlled drift. Brier score against the
  frozen outcome is the registered forecasting-utility metric, with market
  prior and independent-agent average mandatory baselines. All are objective,
  deterministic scorers.
- Evidence status: exploratory real-model mechanism and utility evidence, not
  preregistered confirmatory evidence and not evidence from a live market.

## Consequences

- Phase 5 has a real package with a scripted forecasting-council demo whose
  deterministic outcomes reproduce every aggregate and Brier score from raw
  records, and whose result bundle and summary state plainly that they are a
  construction — not evidence about language models and not evidence about live
  prediction markets.
- The coordination-substrate claim is testable in isolation: schema round-trips,
  drift isolation (including fixture-typo fail-closed), the probability-format
  garbage-average fixture, voluntary surfaces-but-aggregates-all vs enforced
  excludes-with-typed-reason, the false-exclusion guard, Brier recomputation,
  and the leakage-audit gate each have unit coverage.
- CI runs no live model and no network: every path is covered by deterministic
  unit tests with the fixture reference backend.
- The historical pilot can now run fail-closed with real model forecasts and
  official Sema references. Its complete transcripts, usage, malformed
  outputs, provider errors, source fingerprints, model fingerprints, and
  semantic-backend metadata are preserved for audit.
