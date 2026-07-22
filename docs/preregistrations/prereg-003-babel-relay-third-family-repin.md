# Preregistration 003: Babel Relay third family — version re-pin

- Status: draft (registration occurs at the merge commit of this document
  into `main`; that commit hash and its timestamp ARE the registration —
  no field in this document requires manual fill-in at merge time)
- Run deadline: within 7 days of the registration commit; a run after the
  deadline requires a new preregistration
- Authors: Robin Oppenstam (approval), Claude (drafting, orchestration)
- Relationship to [Preregistration 002](prereg-002-babel-relay-third-family.md):
  this document re-registers the SAME third confirmatory arm with a
  correctly recorded harness-version pin. It changes nothing else.

## 1. Why a third registration exists

Preregistration 002 pinned the Claude Code CLI version by stating that "the
version present at registration is recorded here at merge time and any CLI
upgrade between registration and run voids the run." That recording never
happened: 002 was merged on 2026-07-17 with its `Registered:` field and its
CLI version pin left as template placeholders — a process error by the
orchestrator, disclosed here.

The consequence is that 002's voiding rule cannot be evaluated. The CLI
self-updates (002 itself documents 2.1.211 → 2.1.212 drift within one day),
the version installed on 2026-07-17 was not recorded anywhere, and the
version installed at the time of this drafting is 2.1.217. An upgrade
between 002's registration and any run executed now is therefore
near-certain and unverifiable either way. Rather than run an arm whose own
registration arguably voids it, this document re-registers the arm with the
pin recorded correctly, in the draft itself, before merge.

No endpoint data has been collected under 002. **The verdict of 001 remains
SEALED**: no endpoint of any valid arm has been examined. The two valid 001
arms are unaffected. The conjunctive experiment-level claim will be
evaluated across the two 001 arms plus the arm registered here, and
published regardless of outcome.

## 2. Harness version pin (the one substantive addition)

- Claude Code CLI version: **2.1.217**, recorded here at drafting time and
  verified by the harness at run start; the bundle manifest must record
  `claude-code@2.1.217` and any other version disqualifies the run.
- The run executes with `DISABLE_AUTOUPDATER=1` so the version cannot drift
  mid-arm.
- If the CLI upgrades between this document's merge and the run start, the
  run is NOT attempted under this registration; a further re-pin
  registration would be required. (Operationally: the run starts immediately
  after merge to minimize that window.)

## 3. Everything else (incorporated from 002, unchanged)

The following are incorporated by reference from Preregistration 002,
verbatim and unchanged, as if restated here:

- §2 Hypotheses: H1 (addressed silent-divergence Clopper–Pearson 95% UB ≤ 5%
  per addressed arm), H2 (enforced − voluntary task-success Newcombe 95%
  LB > 15 points), H3 (baseline silent-divergence Wilson 95% LB > 50%),
  evaluated per model; the experiment-level claim requires all hypotheses to
  hold for all three arms. No interim analysis; no data-dependent stopping.
- §§3–5 Endpoints, design, pairing, randomization: same six scenarios, same
  30 seeds (0–29), same five conditions on paired blocks via
  `planPairedMatrix`, 900 trials, order seed **20260716**.
- §6 Model and provider: **`claude-haiku-4-5`** via **`--provider
claude-code`** (headless print mode per hop, ADR 0018), author's
  subscription, concurrency deliberately not pinned and recorded in the
  bundle manifest; the prior-exposure disclosure (the 2026-07-17 30-trial
  format smoke) and the three arm-specific disclosures (harness layer,
  conflict of interest, usage limits) carry over unchanged.
- §7 Frozen artifacts: identical pins (fixture digest
  `a8dcdc8d29395b62cfac17b69895b0c71f76f977e3d3c3ccca4a2f9166d97e2c`, prompt
  digest
  `5f8976a6e93d1816dbd1341d5b906df443692e6c81b3ffe2f97e273f394aa99d`, scorer
  `decision-parser-v2-markdown-tolerant`, Sema 0.3.0, canonicalization v2,
  vocabulary root
  `6bb456b3062d94ec02f0a7a53ca8a0b3aefba78f24140d0129bd6da86553b070`,
  semantic backend `semahash-python-workspace-api`). The run MUST execute
  from a clean tree at the registration commit of THIS document or a
  descendant that does not modify `experiments/babel-relay/`, `packages/`,
  or the pinned fixtures/prompts (site-only and docs-only commits are
  permitted). A `+dirty` marker in any bundle manifest disqualifies the run.
  Operationally the run executes from a detached worktree pinned at the
  registration commit.
- §8 Sample size: 900 trials.
- §9 Exclusions: hop-retry exhaustion excludes the trial and is reported in
  full; more than 2% exclusions (>18/900) invalidates the arm for rerun
  under this registration with both bundles published.
- §10 Publication commitment: all bundles publish regardless of outcome —
  including the five failed Qwen attempts under 001 — with the conjunctive
  verdict as the headline whatever it is, and the third-family swap
  presented prominently.
