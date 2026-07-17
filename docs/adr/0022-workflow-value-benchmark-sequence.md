# ADR 0022: Workflow-value benchmark execution sequence

- Status: accepted
- Date: 2026-07-16

## Context

ADR 0021 established a seed-only structured-output scaffold. It deliberately
does not run substantial repository work, test library discovery, or support
writable subscription-harness execution.

The next research objective is to test the founder's proposed value mechanism:
a good reusable library may reduce misunderstanding, wrong turns, failed
attempts, and rework on complex tasks where hydration cost is small relative to
the work.

Attempting to answer that question in one experiment would confound:

- task and validator quality;
- library content;
- lookup and delivery;
- content addressing;
- mismatch notification and enforcement;
- search and pattern selection;
- dependency resolution;
- session reuse; and
- model-harness implementation.

The locked research plan requires a decision record for a material sequence or
causal-model change.

## Decision

Adopt the phased sequence in
[the workflow-value build plan](../WORKFLOW_VALUE_BUILD_PLAN.md):

1. correct roadmap readiness labels;
2. define the corpus contract;
3. acquire sacrificial development tasks;
4. record the sandbox and egress-control decision (isolation technology and
   provider-endpoint allowlist mechanism);
5. implement and validate a controlled writable `AgentWorkflowRunner`;
6. acquire and seal the real corpus;
7. freeze a generic reusable workflow library;
8. test task-only versus identical library content rendered as prose;
9. test prose versus opaque and content-addressed delivery;
10. extract the shared official Sema runtime from experiment-private source
    (parallelizable with 6–9; required before 11);
11. test Sema-native search, selection, dependency resolution, and session
    reuse; and
12. add domain-specific model executors after reusable execution controls exist.

For implementation tracking, the two additive steps delivered by this ADR are:

- **Phase 8 — shared Sema runtime:** extract the prepared official
  workspace/registry runtime from Babel Relay into `packages/sema-runtime`,
  migrate Babel Relay and Babel Repair to the package, and retain the existing
  fixture and official-Python integration seams without changing Babel
  behavior.
- **Phase 9 — discovery and reuse scaffold:** add a separate
  `experiments/sema-discovery` deterministic experiment for
  search → select → resolve dependencies → execute/reuse.

Claude Code is the reference harness for confirmatory comparisons. Other
subscription harnesses remain exploratory unless their budget channel, prompt
delivery, tool policy, and version pin are separately preregistered.

### Phase 8: shared prepared Sema runtime

Create `@sema-evals/sema-runtime` as a reusable workspace package. It owns the
prepared official registry implementation currently located in
`experiments/babel-relay/src/registry-runtime.ts`:

- temporary isolated registry creation and cleanup;
- canonical and single-mutation registry builds;
- exact hydration-parity checks;
- canonical `PROCEED` and drifted `HALT` handshake preflight;
- mutation-isolation checks across every handle;
- prepared `hydrate` and `handshake` calls used during trial execution; and
- canonical vocabulary-root exposure for manifests.

The package composes `@sema-evals/adapters` and `@sema-evals/core`; it does not
reimplement Sema hashing, registry construction, resolution, or handshake
policy. Its public runtime interface remains structurally compatible with the
existing Babel relay/repair consumers.

Migration is behavior-preserving:

- Babel fixture bytes, condition definitions, scorer behavior, events, and
  result schemas do not change.
- Existing workspace ids, labels, temporary-directory prefix, validation
  errors, and official backend calls remain unchanged.
- Prereg-001 is byte-identical and the confirmatory freeze is not amended.
- Babel Repair stops importing private source from its sibling experiment.
- Package tests reproduce canonical/control preparation, isolated drift,
  hydration, handshake, cleanup, and failure cleanup with fake registry clients.
- Existing official Python integration tests remain the integration seam; no
  live official call is added to CI.

### Phase 9: Sema-native discovery and reuse scaffold

Create a separate `experiments/sema-discovery` protocol. It is deterministic
and additive; it does not modify Babel Relay, Babel Repair, Workflow Value, the
workflow runner, sandboxing, corpus acquisition, or any domain executor.

Each fixture defines:

- a small reusable pattern catalog;
- one correct root pattern;
- explicit transitive dependencies;
- plausible distractor patterns;
- two ordered tasks in one logical session that require the same root pattern;
  and
- hidden executable expected outputs.

Every trial starts with an explicit empty session. No cache or selected handle
may leak between condition/seed cells. The trial ends by discarding the session.

Five paired conditions isolate the sequence:

1. `task-only` — task text only; no pattern content.
2. `preselected-prose` — the correct root plus required dependencies are
   preselected and rendered inline.
3. `preselected-addressed` — the identical definitions are preselected,
   delivered by content reference, and hydrated.
4. `discovery` — search, select, and resolve dependencies independently for
   each task; no within-session reuse.
5. `discovery-reuse` — search, select, and resolve on the first task, then reuse
   the prepared dependency closure for the second task in the same session.

The three information-bearing controls receive byte-identical pattern
definitions after resolution. Discovery conditions do not receive the gold
handle in task text. Preselected conditions are controls for delivery after an
oracle selection; their outcomes cannot be described as discovery.

#### Frozen search and ranking

The scaffold uses a versioned deterministic lexical ranker:

- lowercase Unicode text;
- tokenize on non-alphanumeric boundaries;
- query fields: task request only;
- pattern fields: handle, title, purpose, and tags;
- score: count of distinct query tokens present in the pattern fields;
- minimum score: `1`;
- maximum returned candidates: `3`;
- ordering: descending score, then ascending handle;
- selection: the first result;
- catalog iteration order must not affect results.

The exact parameters and ranking fingerprint are recorded in every manifest.
Fixtures must contain at least two distractors and test score ties explicitly.
Changing ranking, tokenization, query fields, result count, or tie-breaking
requires a protocol-version change.

#### Dependency resolution and reuse

Dependencies are handles stored in pattern metadata. Resolution performs a
deterministic depth-first traversal with lexicographically sorted dependency
edges and returns each dependency once before its dependent root. Missing
dependencies and cycles fail closed with typed outcomes and remain scored
trials, not exclusions.

`discovery-reuse` stores the selected root and complete resolved closure in a
trial-local session after the first task. The second task records a reuse hit,
performs no search or dependency traversal, and uses the same resolved
definitions. `discovery` uses a fresh task-local lookup for both tasks even
though the outer trial session exists. Preselected conditions do not count as
reuse.

#### Deterministic execution and metrics

The scripted executor emits the expected artifact only when it receives the
correct root and a complete dependency closure. `task-only`, incorrect
selection, missing dependencies, and dependency cycles yield preserved failed
artifacts. This construction validates the benchmark mechanics only.

Primary descriptive endpoint: **end-to-end discovery success**, requiring
correct selection, complete dependency resolution, and validator-passing
execution for both tasks.

Separate metrics include:

- searches performed and candidates returned;
- correct selection, selected handle, selected rank, and distractors
  considered;
- required/resolved/missing dependency counts and dependency completeness;
- task execution success;
- session reset confirmation;
- reuse hits, searches avoided, and dependency resolutions avoided;
- wire bytes and hydration bytes; and
- elapsed time.

All result manifests record fixture, scorer, protocol, ranker, search
parameters, semantic backend, implementation, dependency lock, and vocabulary
fingerprints. Runs use durable journals and preserve failures. No live model or
network provider is wired; injected fakes may test failure preservation without
making external calls.

## Rationale

### Sacrificial tasks before the sealed corpus

Runner development needs realistic repository tasks. Those tasks cannot later
serve as held-out evidence because the runner, prompts, and telemetry will have
been tuned against them. A small permanent train/development set provides
realism without contaminating evaluation.

### Corpus seal after runner conformance

Sealing before the task format is executable risks acquiring unusable tasks.
Sealing after runner development—but before library, prompt, or protocol tuning
on held-out tasks—preserves both engineering feasibility and research validity.

### Content before addressing

The founder's main hypothesis concerns library value. `task-only` versus
identical library prose measures that content effect without attributing it to
hashing. Opaque lookup and content addressing are added only after the content
effect is separately measurable.

### Discovery after preselected delivery

Preselected delivery asks whether a supplied pattern helps. Discovery asks
whether an agent can find the right pattern in a real library. Combining them
would make it impossible to distinguish a poor pattern from poor search or
selection.

### Enforceable controls before conformance claims

The subscription harnesses must reach their provider APIs, so the runner's
network control is an egress allowlist rather than an air gap, and it must be
enforced at the operating-system level rather than through harness CLI flags.
Several harnesses report token usage only after a run completes, so each
harness declares a budget-enforcement channel — streaming tokens or a
turn/wall-clock proxy — before any budgeted run. Deciding these mechanisms
before runner implementation keeps the conformance suite testable instead of
aspirational.

### Pretraining contamination is tracked, not assumed away

Historical tasks from public repositories may appear in model training data. A
memorized upstream fix biases the library-content effect toward null, so the
corpus records each task's upstream fix date against every pinned model's
training cutoff, acquisition prefers post-cutoff tasks, and contamination-risk
tasks form a preregistered subgroup.

### Controlled runner before domain executors

The existing provider factory standardizes prompt-level invocation. It does not
provide writable workspaces, command policy, hidden validators, or reset
semantics. Building one reusable runner avoids duplicating these controls in
security, x402, and future repository experiments.

### Shared Sema runtime before discovery/reuse

Babel Repair currently reuses Babel Relay's private registry runtime through a
cross-experiment source import. That is acceptable for the additive scaffold
but not as the foundation for search, dependency resolution, and session-state
experiments. Reusable runtime code belongs under `packages/`.

### Discovery and reuse stay separate from delivery

The existing Workflow Value and Sema Tax arms receive a preselected definition.
They can measure content delivery, addressing, hydration, size, and repeated
delivery, but not search quality or library selection. The five-condition
discovery scaffold includes matched preselected controls so discovery failure
cannot be misreported as a content or addressing failure.

### Explicit reset and cache semantics

Reuse is meaningful only when state ownership is visible. Resetting before
every trial prevents cross-condition leakage; caching only inside the
`discovery-reuse` trial makes searches and dependency resolutions avoided on
the second task an exact controlled quantity.

## Consequences

- No paid repository-task model run occurs before corpus and runner gates pass.
- The first workflow-value result estimates library-content value, not a bundled
  “Sema effect.”
- Addressing, enforcement, discovery, and reuse receive separate comparisons.
- Babel Relay and prereg-001 remain unchanged except for an import-path
  migration to behavior-identical shared runtime code.
- Babel Repair no longer reaches into Babel Relay private source.
- The discovery scaffold makes selection, dependency completion, and reuse
  measurable without claiming deterministic workflow or library value.
- Held-out tasks cannot influence runner, library, prompt, or scorer design.
- Subscription harnesses are treated as distinct named implementations, with
  Claude Code as the reference harness for confirmatory runs.
- The runner follows the sandbox/egress decision in ADR 0023; budgeted
  subscription runs remain blocked on per-harness conformance and budget-channel
  declarations.
- Forecasting and x402 have experiment-specific executor contracts but remain
  blocked on their recorded data/model gates. Security additionally remains
  blocked on controlled repository-executor adaptation.
- The project accepts a longer build sequence in exchange for interpretable
  evidence.

## Implementation note: 2026-07-17

Phases 1–5 and the train/development portions of phases 6–12 now have
deterministic implementations. The sacrificial repository corpus contains four
licensed upstream tasks and is sealed for exploratory runner development only.
The Docker runner, generic library, six-condition repository instrumentation,
shared Sema runtime, discovery/reuse scaffold, and domain executor contracts are
present and tested without paid provider calls.

This does not open the evidence gate. The held-out corpus remains empty against
the required minimum of 30 tasks, the library still needs documented human
review, subscription harness and allowlist-proxy conformance remain unverified,
and security still requires controlled repository-executor adaptation. These
blocked items supersede the earlier implementation-oriented consequence that
the runner and all domain executor contracts did not yet exist.

## Rejected alternatives

### Start with a large public benchmark unchanged

Rejected because licensing, contamination, task-family leakage, setup
reproducibility, and validator quality must be audited rather than assumed.

### Give Sema only to the treatment condition

Rejected because improved pattern content would be confounded with addressing
and enforcement. Equal-information prose is mandatory.

### Use historical patches as exact-match scorers

Rejected because multiple valid implementations may solve the same task.
Executable behavior is the primary ground truth.

### Add search to the first workflow experiment

Rejected because search/ranking failure would obscure the content effect and
make a null result uninterpretable.

### Treat every subscription CLI as the same model

Rejected because each harness contributes its own prompts, tools, session
behavior, model routing, and telemetry.

### Build domain executors before the reusable runner

Rejected because each experiment would reproduce sandbox, reset, budget,
command-capture, and result-preservation logic.
