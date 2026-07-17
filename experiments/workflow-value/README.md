# Workflow value

Deterministic scaffold for measuring whether a delivered workflow helps an
executor produce a validator-passing artifact within a fixed total-token budget.
See [ADR 0021](../../docs/adr/0021-workflow-value-experiment-scaffold.md).
The corpus, writable-runner, causal-comparison, and discovery implementation
sequence is defined in the
[workflow-value benchmark build plan](../../docs/WORKFLOW_VALUE_BUILD_PLAN.md).

This package has two deliberately separate paths: synthetic structured-output
fixtures for the original scaffold, and four licensed, independently reviewed
sacrificial repository tasks used only for train/development runner
instrumentation. Neither is a held-out evaluation dataset or evidence of model
improvement.

Opening the gate requires acquisition metadata, not a status flip: license,
timestamp, corpus digest, task-family split method, deduplication report,
leakage review, and validator review are mandatory.

The acquisition contract, review templates, candidate inventory, and
machine-readable gates live under [`acquisition/`](./acquisition/README.md).
The sacrificial manifest is
[`datasets/manifests/sacrificial-development.yaml`](./datasets/manifests/sacrificial-development.yaml),
with its independently verified exploratory seal under `datasets/seals/`.
`pnpm --filter @sema-evals/workflow-value corpus:seal -- ...` creates or verifies
a deterministic corpus seal only after three to five accepted tasks and all
referenced evidence pass validation. The sacrificial train/dev corpus now has
four licensed upstream tasks and an exploratory seal. This does not open the
held-out confirmatory gate, which still requires at least 30 separately acquired
tasks after protocol freeze.

The seed tasks remain structured-JSON mechanism checks. Repository tasks now run
through `@sema-evals/workflow-runner`: an isolated Docker workspace with pinned
snapshot/cache digests, offline trusted setup, path and resource controls,
process tracing, scorer-side checkpoints, hidden validators, complete
transcript/patch preservation, and byte-identical reset.

The deterministic Node 22 conformance image and fake harness are runnable
without provider calls. Claude Code, Codex CLI, Grok Build, Cursor Agent, and
OpenCode remain machine-readably unverified until pinned provider images pass
the common streaming, telemetry, auth-isolation, MCP/web-disable, proxy-egress,
and version probes.

The deterministic records also do **not** establish workflow-library value.
Each task is
paired with a preselected workflow definition by construction. The scaffold
does not test registry search, pattern selection, dependency resolution,
library coverage, ranking quality, or reuse of a discovered pattern within a
session. The separate `sema-discovery` experiment implements deterministic
search/select/dependency/reuse mechanics, but real-agent discovery remains
future work.

The seed workflow currently contains the exact structured output expected by
the validator. That is intentionally an answer-key/copy mechanism check. Real
tasks must instead deliver generic reusable mechanisms or patterns whose
application is necessary but not sufficient to reveal the task-specific
artifact.

## Conditions

- `task-only`
- `equal-prose`
- `opaque-resolver`
- `content-addressed`
- `content-addressed-repair` — content reference plus an explicit mismatch
  notice and repair request

The preselected workflow content is byte-identical and appears exactly once in
the agent-visible context for the three equal-information delivery arms. Only
the addressing channel differs. The repair condition adds the explicit notice.

Repository instrumentation uses the expanded ladder: `task-only`,
`equal-library-prose`, `opaque-resolver`, `content-addressed`,
`content-addressed-notified-repair`, and `content-addressed-enforced`. Equal
prose and resolved-reference arms receive byte-identical library content. Wire
bytes, resolver hydration bytes, agent-context payload bytes, and model tokens
are recorded separately. Repair uses a real stale-root transition; enforcement
refuses to start the runner when the canonical root is not verified.

The source-provenanced library has provisional agent review only. Documented
human review remains pending, so held-out and model gates stay closed.

## Endpoints

Primary: executable hidden-validator success within the fixed 2,048-token
input-plus-output budget, evaluated on the eval split and paired against
`task-only`.

Secondary telemetry includes validator and parse failures, tokens to first
passing solution, failed edit/test cycles, regressions, rework cycles, latency,
input/cached/reasoning/output tokens, retries, provider errors, cost, wire bytes,
and hydration bytes.

The deterministic executor is one-shot, so regressions and rework are zero in
seed runs. Injected fake-model tests exercise multi-attempt failure and rework.
No live provider or network call occurs in CI.

The fake multi-attempt seam reserves 512 tokens before launching another call
and stops when the remaining 2,048-token budget cannot cover that reserve.

## Run

Build shared packages once, then run:

```bash
pnpm experiment:prepare
pnpm experiment:workflow-value

# Requires the locally built deterministic Node 22 conformance image.
pnpm experiment:workflow-repository -- \
  --task qs-cumulative-array-limit \
  --condition equal-library-prose \
  --output /tmp/workflow-repository-smoke.json
```

Every run creates its manifest and journal before matrix execution, appends each
settled trial, preserves failed run state, and finalizes canonical planned-order
artifacts only after completion.
