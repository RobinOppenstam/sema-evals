# Workflow-value benchmark build plan

- Status: accepted
- Date: 2026-07-16
- Decision record:
  [ADR 0022](adr/0022-workflow-value-benchmark-sequence.md)
- Scope: corpus acquisition, controlled repository execution, causal
  comparisons, Sema-native discovery/reuse, and supporting refactors

## Outcome

Build a held-out repository-task benchmark that can answer:

> Does a frozen library of reusable workflow patterns improve objectively
> validated agent work within a fixed resource budget, and what additional
> value—if any—comes from opaque lookup, content addressing, enforcement, and
> Sema-native discovery/reuse?

The benchmark must measure full repository work rather than copying a supplied
answer. An agent must inspect a repository, make bounded changes, run available
checks, react to failures, and finish with an artifact scored by hidden
executable validators.

This plan does not assume a positive Sema effect. A null or negative result is a
valid outcome.

## Why this sequence

The sequence separates five questions that would otherwise be confounded:

1. **Can the task be executed and scored reliably?**
2. **Does the library content help?**
3. **Does the delivery mechanism matter when content is identical?**
4. **Does content addressing prevent or repair controlled semantic drift?**
5. **Can an agent discover and reuse the right pattern without being given the
   answer?**

Corpus construction and runner construction are interdependent. We will first
build a tiny set of sacrificial development tasks, use them to implement the
runner, and only then acquire and seal the real corpus. This avoids two failure
modes:

- designing a large corpus around infrastructure that cannot execute it; and
- tuning the runner, prompts, or library against held-out tasks.

## Non-negotiable research boundaries

- Deterministic scaffold output is never evidence of model improvement.
- Held-out tasks remain sealed until the protocol, library, prompts, runner,
  exclusions, primary endpoint, and analysis are frozen.
- Pattern content is generic and reusable. It must not contain task-specific
  patches, expected outputs, hidden-test facts, or issue-specific answer keys.
- Equal-information prose, opaque-resolver, and content-addressed conditions
  receive byte-identical resolved content.
- The historical upstream patch may help construct validators but is not the
  required solution. Alternative patches pass when the validators pass.
- Every attempted run is preserved, including setup failures, malformed output,
  timeouts, tool errors, over-budget completion, and validator failures.
- No live trading capital, external production writes, or uncontrolled network
  access enters the benchmark.

## Target repository layout

```text
packages/
├── workflow-runner/          reusable controlled repository-task execution
└── sema-runtime/             reusable official Sema workspace/runtime bridge

experiments/workflow-value/
├── acquisition/              source inventory and reproducible acquisition
├── datasets/
│   ├── manifests/            tracked dataset metadata and task digests
│   ├── dev/                  redistributable dev fixtures, when licensed
│   └── heldout/              sealed metadata; raw snapshots may stay external
├── prompts/                  frozen condition-neutral execution prompts
├── validators/               validator adapters and schemas
└── src/                      experiment-specific conditions and analysis

.cache/sema-evals/corpora/    untracked raw repository snapshots and caches
results/workflow-value/       untracked run bundles
```

Raw repositories are not committed merely because they are public. Each source
must explicitly permit the intended use and redistribution. When redistribution
is not allowed or is impractical, the tracked manifest contains acquisition
instructions and hashes while the local snapshot remains untracked.

## Phase 0: correct the public roadmap

### Deliverables

- Replace “dataset/model gate open” language where an experiment-specific model
  executor is not implemented.
- Distinguish:
  - prompt-only model adapters;
  - controlled writable repository runners; and
  - experiment-specific model executors.
- Link this plan from the research roadmap and workflow-value documentation.

### Decision and reasoning

Documentation is part of the evidence surface. Calling a gate “open” when no
runnable executor exists encourages premature model runs and overstates
readiness. Correct status labels make later entry gates enforceable rather than
aspirational.

### Exit gate

No roadmap entry implies that security, forecasting, x402, or workflow-value
repository runs are executable before their model executor and dataset gates
actually pass.

## Phase 1: define the corpus contract

### Initial scope

Start with substantial TypeScript/JavaScript repository tasks that can run on
Node.js 22 or newer in a network-disabled environment after setup.

Python and other ecosystems are expansion tracks after the reference runner is
stable.

### Decision and reasoning

A single initial ecosystem reduces setup, sandboxing, dependency-cache, and
validator variability. Starting multi-language would make runner failures hard
to distinguish from task difficulty. TypeScript/JavaScript also matches the
repository's existing operational stack.

### Task schema

Every acquired task records:

- stable task ID and task-family ID;
- repository origin and immutable source commit;
- acquisition timestamp;
- license and redistribution classification;
- pre-fix repository snapshot digest;
- human-readable task request;
- setup command and offline dependency-cache requirements;
- visible checks available to the agent;
- hidden validator command;
- allowed write paths;
- prohibited paths and secrets;
- expected runtime, disk, memory, and process limits;
- known upstream patch digest, kept scorer-side;
- upstream fix merge date and a per-pinned-model training-cutoff comparison;
- inclusion/exclusion rationale;
- train, development, or held-out split;
- contamination and leakage-review status.

### Task-family definition

Tasks are grouped before splitting using:

- repository and subsystem;
- duplicated or near-duplicated issue text;
- shared upstream patch ancestry;
- bug/feature template;
- root-cause and validator similarity.

### Decision and reasoning

Randomly splitting individual tasks allows near-identical bugs or templates to
appear on both sides of the evaluation. Family-level splitting reduces this
leakage and makes held-out performance a more credible generalization test.

### Validator policy

Validators should combine:

1. repository-native tests or checks;
2. a hidden regression test for the target behavior;
3. lint/type/build checks when relevant; and
4. explicit guards against unrelated breakage.

The hidden validator produces deterministic structured output. An LLM judge is
never the sole scorer.

### Exit gate

- Schema and validation rules are implemented and test-covered.
- Three sacrificial development tasks can be represented without exceptions or
  task-specific runner code.
- No held-out task has been acquired or inspected yet.

## Phase 2: acquire sacrificial development tasks

### Deliverables

Acquire three to five tasks used only for runner development:

- at least one localized bug fix;
- at least one cross-file behavior change;
- at least one task requiring a failed visible test followed by repair.

These tasks are permanently marked `train` or `dev`; they can never move into
held-out evaluation.

### Decision and reasoning

The runner needs realistic fixtures, but using future evaluation tasks for
infrastructure development leaks task structure into the harness. Sacrificial
tasks provide realism without contaminating the confirmatory set.

### Exit gate

Each task:

- materializes from an immutable snapshot;
- installs or restores dependencies without live network access;
- exposes visible checks;
- has at least one hidden validator that fails before the fix and passes after
  a valid fix; and
- can be reset byte-identically between trials.

## Phase 3: implement the controlled `AgentWorkflowRunner`

### Core responsibilities

The reusable runner must:

- create an isolated workspace per trial;
- materialize the exact repository snapshot;
- restore a pinned dependency cache;
- restrict egress during agent execution to an explicit allowlist of the
  selected harness's provider endpoints, blocking every other destination;
- enforce allowed write paths;
- prevent writes outside the workspace;
- enforce process, wall-clock, disk, and memory ceilings;
- invoke a selected harness with explicit tool permissions;
- capture every command, exit code, stdout/stderr digest, and duration;
- preserve the complete model transcript and final patch;
- run visible checks during the workflow;
- run hidden validators scorer-side;
- stop or mark failure when resource budgets are exhausted;
- clean up or retain the workspace according to the result-preservation policy.

### Sandbox and egress mechanism

The subscription harnesses are network clients: they must reach their provider
APIs to function at all. "Network-disabled" therefore means an egress
allowlist, not an air gap. The allowlist must also prevent the permitted
provider channel from being used to fetch arbitrary external content into the
workspace.

Before runner implementation begins, a dedicated decision record must select
the concrete isolation technology (container, namespace/bind-mount sandbox,
dedicated user, or equivalent) and the egress-control mechanism (proxy or
firewall layer). The chosen mechanism must:

- enforce write paths and egress at the operating-system level rather than
  trusting harness CLI flags;
- work on the development platform (WSL2) and in CI;
- be exercised directly by the conformance suite.

Write-path, process, memory, and disk ceilings are enforced by this mechanism.
A CLI flag such as a read-only sandbox mode is a defense-in-depth layer, never
the enforcement boundary.

### Visible versus hidden validation

- The agent may inspect and run repository-native visible checks.
- Hidden validators run scorer-side and their detailed assertions are not placed
  in the agent context.
- The primary endpoint uses the final hidden-validator result.
- “Tokens to first passing solution” refers to the first checkpoint that passes
  the frozen scorer, but the agent does not receive hidden-test details.

A checkpoint is a scorer-side snapshot of the workspace captured at a declared
boundary (for example, after each completed agent turn or tool-command batch).
The checkpoint boundary definition is frozen before instrumentation runs, is
identical across conditions, and is invisible to the agent. Hidden validators
run against checkpoint snapshots offline; no checkpoint result re-enters the
agent context.

### Decision and reasoning

Giving detailed hidden-test failures back to the model turns the held-out test
suite into an iterative answer oracle. Separating visible development feedback
from hidden scoring better reflects real software work and preserves the
meaning of held-out success.

### Budget model

Record separately:

- total model input and output tokens;
- cached-input and reasoning tokens when reported;
- model cost;
- agent turns and provider retries;
- tool-command count and duration;
- visible-validator runs;
- hidden-validator runs;
- total wall-clock time.

The primary confirmatory budget is fixed within each named harness
implementation. Cross-harness results remain separate because CLI scaffolding,
token reporting, tool policies, and model routing differ.

Not every harness reports token usage while a run is in progress; several
report only after completion. Each harness adapter therefore declares its
enforcement channel before any budgeted run:

- **streaming tokens**, where usage is observable during execution and the run
  stops at the token ceiling; or
- **turn/wall-clock proxy**, where the enforced ceiling is turns and wall-clock
  time, with total tokens recorded post-hoc.

The declared channel is part of the frozen protocol for that harness. A
token-denominated primary budget is only valid on a harness whose channel is
streaming tokens; on proxy harnesses the primary budget is the proxy ceiling
and token totals are secondary telemetry.

### Harness conformance suite

Each writable harness adapter must pass the same tests:

- starts from the identical snapshot;
- cannot access parent-repository instructions or unrelated files;
- cannot read home-level or user-level harness configuration that would inject
  instructions, memory, or tools into the trial (user instruction files,
  global settings, installed MCP servers), or the injected surface is pinned
  and recorded;
- can write only allowed paths;
- cannot reach any endpoint outside the declared provider allowlist;
- preserves nonzero exits and timeouts;
- records the exact CLI version and model selector, with harness auto-update
  disabled or the binary otherwise pinned for the duration of a run series;
- produces a final patch and transcript;
- fails closed when required controls are unavailable.

The target harnesses are Claude Code, Codex CLI, Grok Build, Cursor Agent, and
OpenCode. Claude Code is the reference harness: confirmatory comparisons run
on it first, and results from other harnesses are exploratory unless that
harness's budget channel, prompt delivery, tool policy, and version pin are
separately preregistered. No harness is assumed equivalent to another.

### Exit gate

- The sacrificial tasks run end to end through at least one writable harness.
- Reset, sandbox, path, budget, transcript, and validator tests pass.
- A deliberately malicious task cannot escape the allowed workspace.
- A failed agent or validator produces a complete failed result bundle.

## Phase 4: acquire and seal the real corpus

### Acquisition funnel

Target:

- 80–120 candidate historical tasks;
- at least 60 accepted tasks after licensing, reproducibility, duplication, and
  validator review;
- approximately 15 train/instrumentation tasks;
- approximately 15 development tasks; and
- at least 30 sealed held-out tasks.

These are acquisition targets, not a predeclared inferential sample size. The
confirmatory sample-size decision follows baseline variance measurement on
train/development tasks and is frozen before held-out outcomes are inspected.

### Inclusion criteria

- permissive or otherwise explicitly compatible license;
- immutable pre-change snapshot;
- clear, non-answer-bearing task request;
- deterministic offline setup;
- objectively testable behavior;
- meaningful repository work rather than a one-line formatting change;
- expected completion within the runner's operational ceiling;
- no required secret, paid service, production credential, or live network;
- upstream fix merged after the pinned models' training cutoffs where
  possible; earlier tasks carry an explicit pretraining-contamination-risk
  label with justification.

### Exclusion criteria

- unclear license or redistribution status;
- flaky, timing-sensitive, or externally hosted ground truth;
- task text that reveals the patch;
- validators that merely compare against the historical patch;
- dependency installation that cannot be reproduced offline;
- generated/vendor files dominating the patch;
- duplicate or near-duplicate task family;
- task whose expected solution is embedded in the proposed pattern library.

### Review process

Each accepted task receives:

- one acquisition review;
- one independent validator review;
- automated pre-fix-fails/post-fix-passes verification;
- duplicate-family review;
- leakage review against prompts, Pattern Cards, examples, and scorer rules;
  and
- pretraining-contamination review comparing the upstream fix date against
  every pinned model's training cutoff.

Pretraining contamination does not only inflate the `task-only` baseline: a
memorized upstream fix leaves no room for library content to help, biasing the
treatment effect toward null. The confirmatory analysis therefore reports
contamination-risk tasks as a preregistered subgroup.

### Sealing

The held-out seal records:

- corpus manifest digest;
- every snapshot digest;
- every hidden-validator digest;
- family split;
- acquisition metadata;
- exclusions;
- library and prompt digests visible at seal time.

After sealing, held-out task details are unavailable to prompt, runner, library,
or scorer development.

### Exit gate

The acquired-dataset schema passes only with complete evidence. The seal can be
recomputed from a clean environment, and the dataset-acquisition gate changes
to `acquired` without editing experiment code.

## Phase 5: freeze the reusable workflow library

### Library policy

Create or select a small, domain-general software-work library using only:

- existing public Sema patterns;
- general software-engineering sources;
- train and development tasks; and
- documented human review.

Patterns may describe mechanisms such as task framing, evidence-first
diagnosis, layered validation, rollback, state audit, or failure-informed retry.
They must not encode repository-specific fixes.

### Preselection policy

For the first causal comparison, task-to-pattern mapping is frozen using
train/development data before held-out execution. The mapping is scorer-side and
not optimized after observing held-out treatment effects.

### Decision and reasoning

The founder's first question is whether a good library reduces wrong turns and
rework. Preselecting the relevant pattern intentionally removes search quality
from this comparison, isolating the content effect. Search is tested later as a
separate capability.

### Exit gate

- Pattern and prose renderings are byte-equivalent in semantic content.
- No pattern contains held-out answer information.
- Library version, vocabulary root, task mapping, and renderers are frozen.
- Independent leakage review passes.

## Phase 6: content-value experiment

### Conditions

1. `task-only`
2. `equal-library-prose`

Both conditions receive identical:

- repository snapshot;
- task request;
- tools and write permissions;
- visible tests;
- hidden scorer;
- harness/model implementation;
- turn, token, time, and command budgets.

Only the second condition receives the frozen reusable pattern content rendered
as ordinary prose without Sema handles, hashing, lookup, or handshake.

### Primary endpoint

Hidden-validator success within the fixed total model budget.

### Secondary endpoints

- failed visible test cycles;
- tokens to first scorer-passing checkpoint;
- rework cycles;
- regressions;
- unrelated file changes;
- provider/tool failures;
- model tokens, latency, and cost.

### Decision and reasoning

This comparison tests the founder's central economic claim with the fewest
moving parts: does useful library content help agents finish substantial work?
Adding hashes, resolvers, or enforcement at this stage would make a positive
result uninterpretable.

### Execution sequence

1. Instrumentation runs on train tasks.
2. Prompt and telemetry debugging on development tasks.
3. Freeze protocol and analysis.
4. Run an exploratory held-out pilot.
5. Preregister a confirmatory run only if the runner and scorer remain stable.

Agent runs on the same task vary across seeds, so the protocol freeze fixes
the repetition count per task and condition, chosen from between-run variance
measured on train/development tasks. The freeze also records a total cost
envelope — tasks × conditions × repetitions at observed per-run cost — before
any held-out execution. Roughly thirty paired binary outcomes detect only
large effects; if the achievable sample cannot support the preregistered
comparison, that is a stop condition, not a reason to shrink the analysis
after the fact.

The exploratory result is published even if null or negative.

## Phase 7: delivery and addressing experiment

### Conditions

1. `equal-library-prose`
2. `opaque-resolver`
3. `content-addressed`
4. `content-addressed-notified-repair` for controlled drift tasks
5. `content-addressed-enforced` for controlled drift tasks

Resolved semantic content remains byte-identical across the first three
conditions.

### Decision and reasoning

The content-value experiment establishes whether the library itself helps.
Only then is it meaningful to ask whether compact lookup, content addressing,
repair notices, or enforcement add value or cost. The opaque resolver controls
for lookup and compact delivery so an addressing effect is not confused with a
retrieval effect.

### Drift tasks

Addressing and enforcement are evaluated on tasks with a preregistered semantic
boundary where one local workflow definition is deliberately stale. The agent
receives an objective mismatch notice; it never has to infer that hashes differ.

### Exit gate

Reports separate:

- content effect;
- lookup/delivery effect;
- addressing/detection effect;
- notification/repair effect;
- enforcement effect; and
- wire, hydration, provider-token, latency, and failure costs.

## Phase 8: extract the reusable Sema runtime

Status: prepared official workspace/registry runtime extracted to
`packages/sema-runtime`; Babel Relay and Babel Repair migrated. Broader
search/session policy remains experiment-specific.

### Deliverables

Move the reusable prepared-workspace runtime currently imported from
`experiments/babel-relay/src` into `packages/sema-runtime` or
`@sema-evals/adapters`.

The package should expose:

- isolated workspace preparation;
- canonical and drifted registry materialization;
- lookup and dependency resolution;
- single-pattern and vocabulary handshakes;
- context verification;
- cleanup;
- complete Sema/canonicalization/vocabulary provenance.

### Decision and reasoning

Cross-experiment source imports work today but make experiment packages depend
on another experiment's private implementation. The discovery/reuse arm will
need search, resolution, session state, and handshakes; extracting the runtime
before that arm prevents a second private implementation and keeps reusable
code under `packages/`.

This phase depends on no corpus or experiment phase. It may start any time
after the runner exists and proceed in parallel with Phases 4–7; the only hard
ordering constraint is completion before Phase 9.

### Exit gate

Babel Relay and Babel Repair consume the package without behavior or fixture
changes. Official Sema integration tests remain green.

## Phase 9: Sema-native discovery and session reuse

Status: deterministic/fake scaffold implemented in
`experiments/sema-discovery`; real-agent discovery remains exploratory future
work.

### Question

Can an agent find, select, resolve, and reuse the right pattern without being
given the gold handle?

### Conditions

At minimum:

1. `task-only`
2. `preselected-prose`
3. `preselected-addressed`
4. `discovery`
5. `discovery-reuse`

### Discovery protocol

- The agent receives the task but not the gold handle.
- The registry includes relevant candidates and plausible distractors.
- Search implementation, library size, ranking parameters, dependency graph,
  and vocabulary root are frozen. The deterministic scaffold uses a versioned
  lexical ranker; a future embedding/model ranker requires a protocol change.
- The agent selects a pattern, resolves required dependencies, and records why
  it selected or rejected candidates.
- Reuse tasks occur within a controlled session where prior served-pattern state
  is visible and reset behavior is explicit.

### Primary and secondary endpoints

- Primary descriptive scaffold endpoint: correct selection, complete dependency
  closure, and validator-passing execution for both session tasks.
- A future real-agent benchmark retains hidden-validator success within budget
  as its workflow endpoint.
- Correct-pattern selection.
- No-selection and false-selection rates.
- Dependency completeness.
- Unnecessary dependency loading.
- Marginal tokens and latency after first resolution.
- Stale-session reuse and context-compaction failures.

### Decision and reasoning

Preselected delivery can show that a pattern helps when supplied. It cannot show
that a useful library is navigable. Discovery/reuse is therefore a separate
causal experiment rather than an extra condition silently added to the content
study.

### Exit gate

The report distinguishes:

- library coverage;
- search/ranking quality;
- selection quality;
- dependency resolution;
- session amortization; and
- downstream workflow success.

## Phase 10: experiment-specific model executors

### Deliverables

After the workflow runner is stable:

- adapt security tasks to the controlled repository runner;
- add forecasting's separate model-council executor;
- add x402's model payer/executor;
- reuse the shared provider factory for prompt-level calls;
- reuse the controlled harness layer only where writable tools are required.

### Decision and reasoning

The shared provider factory solves model invocation, not experiment execution.
Building every executor before the workflow runner would duplicate sandbox,
budget, preservation, and transcript logic. The reusable runner comes first;
domain executors then remain thin and experiment-specific.

## Planned artifacts

- ADR 0022: sequence and causal decisions.
- Sandbox and egress-control decision record (isolation technology, provider
  allowlist mechanism, WSL2/CI validation).
- Corpus schema and acquisition manifest schema.
- License and redistribution review template.
- Task-family, deduplication, and pretraining-contamination report.
- Controlled runner package and harness conformance suite.
- Per-harness budget-channel declarations (streaming tokens versus
  turn/wall-clock proxy).
- Dataset seal and reproducibility command.
- Frozen library manifest and leakage audit.
- Content-value preregistration.
- Delivery/addressing preregistration.
- Discovery/reuse protocol and preregistration.
- Preregistrations for this benchmark carry a machine-readable pin block
  rather than relying on regex extraction from prose.
- Public report generated from raw preserved bundles.

## Stop conditions

Pause before model spending if:

- fewer than 30 held-out tasks survive review;
- task setup or validators remain flaky;
- hidden tests leak into agent-visible context;
- the runner cannot enforce path/process controls or restrict egress to the
  declared provider allowlist at the operating-system level;
- token telemetry is unavailable for the chosen primary budget and no
  turn/wall-clock proxy channel has been preregistered for that harness;
- the planned tasks × conditions × repetitions sample cannot support the
  preregistered comparison within the recorded cost envelope;
- pattern content contains task-specific answer information;
- task-family leakage cannot be ruled out;
- the selected harness cannot be pinned and reproduced.

Stop or redesign after development runs if:

- task-only success is near zero or near one, leaving no useful discrimination;
- most failures come from setup rather than agent work;
- validators reject legitimate alternative solutions;
- the library is irrelevant to most tasks;
- provider/harness instability dominates condition differences.

## Immediate implementation queue

1. Land ADR 0022 and this plan.
2. Correct roadmap readiness labels.
3. Implement the corpus/task schemas and review templates.
4. Acquire three to five sacrificial development tasks.
5. Land the sandbox and egress-control decision record.
6. Implement the reference `AgentWorkflowRunner` and conformance suite.
7. Acquire, review, split, and seal the real corpus.
8. Freeze the generic workflow library.
9. Run the content-only experiment.
10. Run delivery/addressing comparisons.
11. Extract and extend the shared Sema runtime before discovery/reuse
    (parallelizable with 7–10).
12. Build the Sema-native discovery/reuse experiment.
13. Add domain-specific model executors using the shared infrastructure.

## Implementation status: 2026-07-17

Completed for deterministic train/development instrumentation:

- corpus/task schemas, acquisition evidence, independent reviews, and a
  four-task exploratory sacrificial seal across three licensed upstream
  repositories;
- ADR 0023's Docker/OCI sandbox and egress-control decision;
- the reference `AgentWorkflowRunner`, deterministic conformance image, fake
  harness, resource/path/process controls, scorer-only hidden validation, and
  complete transcript/patch/failure preservation;
- a source-provenanced generic workflow library with equal-information
  rendering and leakage checks;
- the six-condition repository instrumentation ladder, including real
  stale-root notification/repair and a fail-closed enforcement transition;
- the shared prepared official Sema runtime and deterministic
  discovery/selection/dependency/session-reuse scaffold; and
- forecasting and x402 model-executor contracts plus the security executor
  contract and its explicit repository-adaptation prerequisite.

The following gates remain closed:

- the held-out corpus is `0` of the required `>=30` independently acquired and
  family-split tasks;
- the generic workflow library still requires documented human review;
- Claude Code, Codex CLI, Grok Build, Cursor Agent, and OpenCode remain
  unverified until pinned provider images pass the common streaming, telemetry,
  auth-isolation, MCP/web-disable, proxy-egress, and version probes;
- no pinned allowlist-proxy image is present for live-provider egress
  conformance;
- the security experiment still needs adaptation from prompt-level contract
  review to the controlled repository executor; and
- no paid model or held-out run is authorized until all applicable gates pass.
