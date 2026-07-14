# Locked research plan

Status: accepted on 2026-07-14. Changes require an ADR explaining why the
sequence or causal model changed.

## Research thesis

Sema may provide value through three independent mechanisms:

1. **Content** — a well-specified pattern improves the task.
2. **Addressing** — a content-derived reference reveals definition drift.
3. **Enforcement** — a compliant runtime prevents work under misalignment.

Experiments must not attribute a content or enforcement effect to hashing.

## Phase 0: foundation

Deliverables:

- Provider-neutral TypeScript schemas and adapters.
- Paired and randomized matrix execution.
- Complete JSONL trial records and reproducibility manifests.
- Deterministic Babel Relay with objective scoring.
- CI covering format, lint, types, and tests.

Exit gate: a clean checkout can run the deterministic experiment and reproduce
all aggregates from raw trial records.

## Phase 1: Babel Relay pilot

Primary endpoint: silent semantic-divergence rate.

Design:

- 12 to 20 ambiguity-prone contract fixtures.
- Drift and no-drift controls.
- Five conditions separating content, lookup, addressing, and enforcement.
- Five paired repetitions for instrumentation, then at least 30 for the first
  model pilot.
- Randomized execution order with the same scenario/seed blocks.

Exit gate: scoring has deterministic tests, model outputs are schema-valid or
preserved as failures, and every result can be traced to prompt/model/data
fingerprints.

## Phase 2: Sema tax curve

Primary endpoint: task success per total model token.

Vary active pattern count at `0, 2, 4, 8, 12, 16` under cold hydration, warm
cache, full prose, opaque resolver, and content-addressed resolver conditions.

Exit gate: wire bytes, hydration bytes, input/output tokens, cost, latency,
quality, and between-run variance are reported separately.

## Phase 3: A2A semantic extension

Build an extension-compatible middleware prototype without forking A2A. Agent
Cards advertise canonicalization and vocabulary-root support; task messages
carry required semantic references and acceptance contracts.

Primary endpoint: silent execution under cross-agent registry drift.

Exit gate: a two-agent demo detects a controlled mismatch under current A2A
conventions and distinguishes voluntary detection from enforced halt.

## Phase 4: security domain trials

Extract generic evaluation infrastructure from HexSec and evaluate a public
`sema-sec` candidate vocabulary on mutation-backed Solidity cases.

Primary endpoint: vulnerability recall at a fixed false-positive budget.

Exit gate: at least 30 cases, clean negatives, train/heldout separation, Foundry
ground truth where possible, two model families, and no domain knowledge leaked
from heldout fixtures into Pattern Cards.

## Phase 5: forecasting council

Use frozen, timestamped evidence for resolved historical markets. Agents first
forecast independently, then exchange structured evidence. Sema aligns event
resolution, evidence cutoff, probability format, and aggregation rules—not
beliefs or point estimates.

Primary endpoint: Brier score against resolved outcomes.

Exit gate: an exploratory 50-question run passes leakage audits before scaling
to 300 or more questions. Market probability and independent-agent averaging
remain mandatory baselines. PnL is secondary and paper-only.

## Parallel infrastructure track

- TypeScript/Python canonicalization-v2 differential vectors.
- A sidecar empirical registry keyed by exact pattern hash.
- x402 payment-contract drift fixtures.
- Public static reports generated from raw result bundles.

These tracks may proceed early only when they do not delay the current phase's
exit gate.
