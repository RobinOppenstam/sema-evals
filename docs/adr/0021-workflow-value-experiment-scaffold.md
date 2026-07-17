# ADR 0021: workflow-value experiment scaffold

- Status: accepted
- Date: 2026-07-16

## Context

The existing experiments test semantic coordination mechanisms, but they do not
directly measure whether a reusable workflow definition helps an executor finish
a practical structured task under a fixed resource budget. A credible
workflow-value experiment needs executable outcomes, equal-information controls,
paired task randomization, explicit dev/eval separation, complete failure
preservation, and workflow-specific telemetry such as rework and tokens to the
first passing solution.

The repository now exposes a shared `createModelProvider` factory across API and
subscription-harness providers. New model-capable experiments must use that
factory instead of adding provider-specific construction branches.

## Decision

### Seed-only deterministic scaffold

`experiments/workflow-value` ships synthetic fixtures whose ids begin with
`seed-dev-` or `seed-eval-`. They validate mechanics only. The fixture metadata
is explicitly `seed-only`, the summary repeats that limitation, and a
dataset-acquisition gate refuses model-provider construction until an
independently sourced dataset is frozen with licensing, deduplication, validator
review, and documented dev/eval partitioning.

The schemas are dataset-neutral: labels and task ids are not seed literals, so
an acquired dataset can pass validation without a code change.

The gate cannot open by changing `status` alone. Acquired metadata must include
license, acquisition timestamp, corpus digest, task-family split method,
deduplication report, leakage review, and validator review.

Each seed task receives a preselected workflow definition. Seed results are
therefore not evidence that a workflow library is useful, has adequate
coverage, or supports successful discovery. Registry search, candidate
selection, dependency resolution, and within-session reuse are explicitly out
of scope and require a separate comparison against matched preselected-delivery
controls.

The seed workflow definition contains the exact structured output checked by
the validator. This is deliberately an answer-key/copy scaffold for mechanism
testing. A real corpus must deliver generic reusable mechanisms or patterns,
not task-specific expected artifacts; task completion must still require
application to the held-out task state.

The CLI supports `deterministic-harness` only. Model execution exists solely as
an injected adapter path for fake-model unit tests; CI performs no live calls.
Future pilots must pass the acquisition gate and construct adapters through the
shared `createModelProvider` factory.

That factory returns completion adapters, not a writable repository agent.
Shared subscription harness adapters disable tools or run in isolated
workspaces, so the current seam does not make founder-style repo edit/test
workflows runnable. The task schema reserves a `repository-workspace` contract
containing a repository fixture, setup command, validator command, and allowed
paths. Executing it requires a future controlled, tool-using
`AgentWorkflowRunner` with sandboxed writes and captured command transcripts.
That additive runner was subsequently implemented under
`packages/workflow-runner`; this ADR's original five-condition seed protocol
remains unchanged, while repository instrumentation is governed by ADRs 0022
and 0023.

### Five paired conditions

Every task/seed block runs all conditions in recorded randomized order:

1. `task-only`
2. `equal-prose`
3. `opaque-resolver`
4. `content-addressed`
5. `content-addressed-repair`

The workflow library content is byte-identical and appears exactly once in the
agent-visible context for equal prose, opaque resolver, and content-addressed
delivery. These arms vary transport/addressing only. Resolver hydration is
accounted separately from wire bytes. The repair condition adds a single
explicit mismatch notice and request to repair the local draft against the
resolved workflow.

### Hidden executable validator

Each task requires one strict JSON artifact with workflow id, ordered actions,
required artifacts, escalation target, and completion state. In the seed
mechanism scaffold, the delivered `workflow.output` intentionally equals the
scorer-side expected artifact; this is an answer-key/copy check, not a hidden
reasoning benchmark. The validator object itself remains scorer-side. Acquired
tasks must instead deliver generic reusable mechanisms or patterns, not
task-specific expected artifacts. The frozen validator performs exact
deterministic checks; malformed outputs, provider failures, and over-budget
passes remain failed trials.

### Fixed budget and endpoints

All conditions use a fixed 2,048-token input-plus-output budget. Before another
model call starts, the fake multi-attempt seam requires a preregistered
512-token invocation reserve. It stops when the remaining budget cannot cover
that reserve.

- Primary: validator success within budget on the eval split.
- Primary comparison: paired success difference from `task-only` on identical
  task/seed blocks.
- Secondary: validator/parse failures, tokens to first passing solution, failed
  edit/test cycles, regressions, rework cycles, latency, input/cached/reasoning/
  output tokens, retries, provider errors, cost, wire bytes, and hydration bytes.

The deterministic seed executor is one-shot. Its rework and regression counts
are therefore zero; failed one-shot outputs count as one failed edit/test cycle.
The injected fake-model runner permits up to three cycles, returns generic
validator feedback, stops at the first passing solution or exhausted budget, and
records cumulative telemetry. It stops at first pass, so regression measurement
remains a future tool-using workflow extension.

### Preservation and provenance

The CLI creates a durable result journal and validated manifest before executing
the paired matrix. Every settled record is appended in completion order, failed
run state is retained, and canonical trials/summaries are finalized in planned
order. Manifests include fixture and prompt digests, scorer and protocol
fingerprints, fixed budget and randomization configuration, semantic backend,
implementation/dependency provenance, and the dataset-gate verdict.

## Consequences

- The evaluation contract is executable and budget-aware without claiming seed
  outcomes are model evidence.
- Equal-information delivery comparisons are isolated from duplicated workflow
  content.
- Provider and malformed-output failures are schema-valid records rather than
  exclusions.
- A real model pilot remains intentionally blocked on dataset acquisition.
- Tool-using workflows that can measure post-pass regressions are future work.

The future Sema-native discovery/reuse arm must measure search → select →
resolve dependencies → execute → reuse within a session. Discovery accuracy,
dependency failures, and session reuse/amortization must be reported separately
from the preselected-definition delivery effect isolated here.
