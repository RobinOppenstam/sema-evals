# Codex Hook

> **Exploratory pilot. Not preregistered, not confirmatory evidence.**
> Single model (gpt-5.6-luna, reasoning effort low, via the OpenAI Codex CLI
> 0.144.5), small n, run 2026-07-19. Published for transparency as the
> second-harness companion to [babel-hook](../babel-hook/).

Codex Hook replays the babel-relay drift scenarios through **real OpenAI
Codex sessions** with the sema ref-gate hook enforcing at the harness
boundary. Where [babel-hook](../babel-hook/) ran the gate as a Claude Code
`UserPromptSubmit` hook, this experiment asks whether the same mechanism —
and literally the same artifact — transfers to a different harness and a
different model family.

## The portability result

**Codex consumes Claude Code plugins natively.** The unmodified sema plugin
(`.claude-plugin/plugin.json` + `hooks/hooks.json` + `hooks/ref_gate.py` from
[RobinOppenstam/sema@`feat/sema-check`](https://github.com/RobinOppenstam/sema/tree/feat/sema-check))
was installed via a local codex plugin marketplace with **zero changes**.
Codex expands `${CLAUDE_PLUGIN_ROOT}` and `${SEMA_PYTHON:-python3}` from the
Claude hook config, fires `UserPromptSubmit` per hop, treats hook exit 2 as a
block, and injects hook stdout as model-visible context (verified in
`records/2026-07-19-luna/warn-mode-repro-transcript.txt`: the model explicitly
reasons about "the supplied reference is marked stale" before halting).

Setup, reproduced:

```bash
# marketplace dir containing .claude-plugin/marketplace.json listing the
# sema checkout (mcpServers stripped from plugin.json to keep runs hermetic)
CODEX_HOME=<isolated-home> codex plugin marketplace add <marketplace-dir>
CODEX_HOME=<isolated-home> codex plugin add sema@<marketplace-name>
```

Runs use an isolated `CODEX_HOME` (own `config.toml`: `model = "gpt-5.6-luna"`,
`model_reasoning_effort = "low"`, `features.hooks = true`) and
`--dangerously-bypass-hook-trust` for headless execution.

## Design

Same registries (honest minted stubs, built by
[babel-hook/build_dbs.py](../babel-hook/build_dbs.py)), same scenario stubs
(read from babel-hook's published records), same conditions differing only in
`SEMA_REF_GATE`:

| Condition | Gate behavior                                                 |
| --------- | ------------------------------------------------------------- |
| `off`     | hook exits immediately                                        |
| `warn`    | STALE verdict injected as model-visible context, never blocks |
| `enforce` | STALE ref blocks the hop (exit 2), relay halts                |

Two phases:

1. **Single-hop** (`singlehop.py`, 60 trials): the babel-hook `run_ab.py`
   probe design, unchanged.
2. **Multi-hop** (`multihop.py`, 144 trials): the full babel relay —
   3 boundaries, frozen prompts (snapshot 2026-07-14.2, read-only from
   `experiments/babel-relay/prompts/`), mutation injected at each scenario's
   declared boundary, scorer-v2 audit parsing.

Documented deviations from the Claude Code runs:

- Frozen boundary prompts are delivered via a per-trial `AGENTS.md` (codex
  has no `--system-prompt` flag; `AGENTS.md` is its idiomatic instructions
  channel), plus the harness note below.
- A hop counts as gate-blocked only if codex reports the hook block **and**
  no final message was produced — codex internally retries transient hook
  failures within one invocation, unlike `claude -p`.

## Results

**Multi-hop, corrected run (144 trials; n=48/arm: 32 drift + 16 clean):**

| Condition | Gate detection | Drift halted | Shipped despite drift | Clean success | Task success |
| --------- | -------------- | ------------ | --------------------- | ------------- | ------------ |
| off       | —              | 10/32        | 22/32 (69%)           | 15/16         | 25/48 (52%)  |
| warn      | 32/32 (100%)   | 23/32        | **9/32 (28%)**        | 12/16         | 35/48 (73%)  |
| enforce   | 32/32 (100%)   | **32/32**    | 0                     | 16/16         | **48/48**    |

Cross-harness comparison with babel-hook (haiku, Claude Code, n=60/arm):

- **Baseline drift shipping is nearly identical**: 70% (haiku/CC) vs 69%
  (luna/codex). The failure the gate addresses is harness- and
  model-independent.
- **The voluntary tier more than doubled its leak rate**: 12.5% → 28%,
  with 100% gate detection in both. The model reads the warning and ships
  anyway; leaks concentrate by scenario (token-decimal-domain leaked 5/8
  reps). Detection quality is constant; voluntary compliance is a
  model-dependent variable.
- **Enforcement was deterministic in both**: 40/40 and 32/32 drifted relays
  halted before any model call (`audit ran: 0` on every enforced drift
  trial). Zero false blocks on clean refs in either harness, either phase.

**Single-hop (60 trials; 8 drift + 12 clean per arm):** off 0/8 detection
(luna never self-suspected drift), warn 8/8 gate detection with 3/8 leaks,
enforce 8/8 blocked pre-model. Compare haiku single-hop: warn leaked 0/8 on
the identical protocol — again, voluntary compliance varies by model,
enforcement doesn't. Three warn-arm trials logged a transient `Blocked` line
from hook cold-start timeouts under concurrency, after which codex internally
retried and completed the turn; `singlehop-results-rescored.jsonl` classifies
those by final outcome (the shipped summary table reflects the re-score).

## A finding about harness semantics (run 1)

The first 144-trial multi-hop run was invalidated by a real cross-harness
difference: **codex agents verify against the filesystem, not just the
message**. The audit hop inspected the (empty) working directory, found no
implementation files — the relay artifact exists only inline — and halted
every trial, drift and clean alike ("the workspace contains no implementation
or tests"). Claude Code's `claude -p --tools ""` has no tools and judges the
inline text.

The fix is a neutral harness note appended to `AGENTS.md` stating that
artifacts are inline and the empty workspace carries no signal; a validation
trial then proceeded on the merits. Run 1 is archived in full
(`multihop-run1-*`) — the gate behaved identically in both runs; it is the
surrounding agent behavior that shifts per harness. This is the concrete
argument for shims staying thin over a shared `sema check` primitive while
each harness's delivery semantics are conformance-tested separately.

## Caveats

- Exploratory: no preregistration, one model at one effort setting, modest n.
- The warn condition injects the warning adjacent to the task at every hop —
  a best case for voluntary compliance; the 28% leak is likely a lower bound.
- `--dangerously-bypass-hook-trust` bypasses codex's hook-trust review; the
  hook under test is our own. Production installs should use the interactive
  `/hooks` trust flow instead.
- Trials share one codex plugin cache and auth; conditions are interleaved so
  interrupted runs stay balanced.
- Conflict-of-interest disclosure: as with babel-hook, the author of this
  experiment also wrote the gate hook under test and collaborates on sema.

## Reproducing

```bash
# 1. Registry (in this directory or point CANON_DB elsewhere)
SEMA_REPO=/path/to/sema python3 ../babel-hook/build_dbs.py   # or rebuild canon.db here

# 2. Isolated CODEX_HOME with the sema plugin (see setup above), then:
CODEX_HOME_DIR=/path/to/isolated-home \
CANON_DB=/path/to/canon.db \
SEMA_PYTHON=/path/to/sema/.venv/bin/python \
python3 multihop.py > mh-summary.txt 2> mh-progress.log
```

Raw records live in `records/2026-07-19-luna/`: per-trial JSONL for the
single-hop run (original + re-scored), both multi-hop runs (run 1 archived
with its workspace-artifact flaw, run 2 corrected), summaries, progress logs,
per-trial gate verdict logs for all three, and the warn-mode reproduction
transcript.
