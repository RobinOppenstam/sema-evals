# Preregistration 002: Babel Relay confirmatory experiment — third-family completion

- Status: draft (registration occurs at the merge commit of this document into
  `main`; that commit hash is the registration timestamp)
- Registered: (filled by the merge commit)
- Run deadline: within 7 days of registration; a run after the deadline
  requires a new preregistration
- Authors: Robin Oppenstam (approval), Claude (drafting, orchestration)
- Relationship to [Preregistration 001](prereg-001-babel-relay-confirmatory.md):
  this document registers a REPLACEMENT THIRD MODEL FAMILY for the
  three-family confirmatory design of 001. It changes nothing else.

## 1. Why a second registration exists

Preregistration 001 named three model families. Two arms completed validly,
executed from the registration commit `e83e103` itself with a clean tree:

- `unsloth/Mistral-Nemo-Instruct-2407-TEE` — 900 trials, 0 exclusions
  (bundle `20260715T122438426Z-order-20260716`)
- `MiniMaxAI/MiniMax-M2.5-TEE` — 900 trials, 6 exclusions, 0.67%
  (bundle `20260715T141423974Z-order-20260716`)

The third family, `Qwen/Qwen3-32B-TEE` on the pinned provider, failed
**five consecutive attempts** on infrastructure grounds between 2026-07-15 and
2026-07-17: run 1 invalid (139 exclusions, 15.4%), attempts 2 and 3 aborted
early on latency telemetry, run 4 invalid by one trial (19 exclusions, 2.11%
against the ≤2% rule — enforced without discretion), attempt 5 aborted at a
calibrated live exclusion proxy after sustained provider degradation waves
(300–700 s hop latencies with retry exhaustion). All five attempts are
published: both invalid bundles flagged per 001 §9, all abort logs preserved.
Attempt 5 additionally executed from a descendant commit that had modified
001 §7 protected paths (`experiments/babel-relay/`, `packages/`) — a process
error by the orchestrator, disclosed here; it produced no endpoint data and
was aborted on infrastructure grounds independent of that violation. The two
valid arms are unaffected (registration-commit execution, verified from their
bundle manifests).

**The verdict of 001 remains SEALED.** No endpoint of any valid arm has been
examined. This registration exists solely so the third arm can run on
infrastructure that can sustain it. The conjunctive experiment-level claim
will be evaluated across the two 001 arms plus the arm registered here, and
published regardless of outcome.

## 2. Hypotheses (unchanged from 001 §2)

H1 (addressed silent-divergence Clopper–Pearson 95% UB ≤ 5% per addressed
arm), H2 (enforced − voluntary task-success Newcombe 95% LB > 15 points), H3
(baseline silent-divergence Wilson 95% LB > 50%) — verbatim as 001 §2,
evaluated per model; the experiment-level claim requires all hypotheses to
hold for all three arms (the two valid 001 arms and this one). No interim
analysis; no data-dependent stopping.

## 3–5. Endpoints, design, pairing, randomization (unchanged)

Identical to 001 §§3–5: same six scenarios, same 30 seeds (0–29), same five
conditions on paired blocks via `planPairedMatrix`, 900 trials, order seed
**20260716** (the same order used by both valid arms, so all three arms share
identical blocks and order).

## 6. Replacement model and provider (pinned)

- Model: **`claude-haiku-4-5`** (Anthropic Claude Haiku 4.5).
- Provider: **`--provider claude-code`** — the harness spawns the locally
  installed Claude Code CLI in headless print mode per hop (ADR 0018),
  running under the author's Claude subscription. No API key is used.
- The Claude Code CLI version is recorded in every bundle manifest
  (`claude-code@<version>`); the version present at registration is recorded
  here at merge time and any CLI upgrade between registration and run voids
  the run. The run executes with the CLI's self-updater disabled via
  environment (`DISABLE_AUTOUPDATER=1`) so the version cannot drift mid-arm
  (observed drift 2.1.211 → 2.1.212 within one day during provider
  development).
- max-tokens and sampling: NOT controllable through this provider (disclosed
  limitation, ADR 0018); the CLI's defaults at the pinned version apply. The
  frozen prompts and scorer are identical to 001, so endpoint definitions are
  unchanged.
- Concurrency: **deliberately not pinned** (001 pinned concurrency 10 in
  prose; that pin added nothing scientifically and constrained infrastructure
  adaptation — recorded here as the lesson). The concurrency actually used is
  recorded in the bundle manifest.
- Prior exposure: claude-haiku-4-5 has never run any babel-relay trial. An
  exploratory 30-trial format smoke (1 repetition) was run on 2026-07-17
  before this registration (exploratory bundle
  `20260717T070157676Z-order-20260714`): 30/30 trials completed, 0 hop
  failures, 0 exclusions, 30/30 parseable DECISION verdicts, hop latencies
  15–171 s (median ≈ 65 s including CLI session-spawn overhead). The smoke
  examined format compliance and provider mechanics; its per-condition
  numbers are exploratory (n=6 per arm) and carry no confirmatory weight.

### Disclosures specific to this arm

1. **Harness layer.** Calls pass through the Claude Code CLI harness rather
   than a raw API: an uncontrolled-by-us system layer sits between the frozen
   prompt and the model. The CLI version is pinned and recorded; ADR 0018
   documents exactly which prompt surfaces are controlled (system prompt
   override, tools disabled, single turn, no session persistence).
2. **Conflict-of-interest note.** This evaluation suite is orchestrated by
   Claude (Anthropic) and this arm evaluates an Anthropic model executed
   through Anthropic's own CLI on the author's subscription. The deterministic
   frozen scorer, the published raw bundles, and the recompute-from-artifacts
   site pipeline are the mitigations: every aggregate is recomputable by
   third parties from published trial records.
3. **Usage limits.** Subscription usage-limit throttling, if it occurs,
   surfaces as hop failures and is governed by the same ≤2% exclusion rule —
   it cannot silently bias endpoints.

## 7. Frozen artifacts (registration pins)

Identical to 001 §7 and re-verified by the harness at run time:

- Fixture digest: `a8dcdc8d29395b62cfac17b69895b0c71f76f977e3d3c3ccca4a2f9166d97e2c`
- Prompt digest: `5f8976a6e93d1816dbd1341d5b906df443692e6c81b3ffe2f97e273f394aa99d`
- Scorer version: `decision-parser-v2-markdown-tolerant`
- Sema version 0.3.0; canonicalization v2; vocabulary root
  `6bb456b3062d94ec02f0a7a53ca8a0b3aefba78f24140d0129bd6da86553b070`
- Semantic backend: `semahash-python-workspace-api`
- Implementation: the registration merge commit of THIS document. The run
  MUST execute from a clean tree at that commit or a descendant that does not
  modify `experiments/babel-relay/`, `packages/`, or the pinned
  fixtures/prompts (site-only and docs-only commits are permitted). A
  `+dirty` marker in any bundle manifest disqualifies the run. Operationally
  the run executes from a detached worktree pinned at the registration
  commit.

## 8. Sample size (unchanged)

900 trials, as 001 §8.

## 9. Exclusions and failure handling (unchanged)

As 001 §9: hop-retry exhaustion excludes the trial and is reported in full;
more than 2% exclusions (>18/900) invalidates the arm for rerun under this
registration with both bundles published.

## 10. Publication commitment

Identical to 001: all bundles publish regardless of outcome — including the
five failed Qwen attempts under 001 — with the conjunctive verdict as the
headline whatever it is. The published report must present the third-family
swap prominently, including the fact that the originally registered family
could not be completed on its provider.
