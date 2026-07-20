# Cursor Hook

> **Exploratory pilot. Not preregistered, not confirmatory evidence.**
> Single model (composer-2.5-fast via the Cursor CLI, cursor-agent
> 2026.07.16-899851b), run 2026-07-20. Third harness in the series after
> [babel-hook](../babel-hook/) (Claude Code) and [codex-hook](../codex-hook/)
> (OpenAI Codex).

Cursor Hook replays the babel-relay drift scenarios through **real Cursor CLI
sessions** — but unlike the first two harnesses, the gate here is a **Tier 3
wrapper**, not an in-harness hook. Cursor's CLI build contains the full hook
machinery (native `.cursor/hooks.json` plus Claude Code-compatible
`.claude/settings.json` loading, documented since Cursor 2.4), but hook
dispatch is gated by a server-delivered config flag (`claude_code_hooks_enabled`)
and no hook fired in headless `-p` mode on this account, at any config level,
in either format. So this run tests the capability ladder's universal
fallback: `sema check --json` verdicts each hop's inbound message **before**
`cursor-agent` is invoked (see [`sema-cursor`](./sema-cursor) for the
standalone wrapper, [`multihop.py`](./multihop.py) for the experiment runner).

| Condition | Gate behavior                                                    |
| --------- | ---------------------------------------------------------------- |
| `off`     | no gate; message delivered untouched                             |
| `warn`    | stale refs → repair text prepended to the prompt (model-visible) |
| `enforce` | stale refs → cursor-agent never invoked; relay halts             |

Same three boundaries, frozen prompts (snapshot 2026-07-14.2, read-only,
delivered via `AGENTS.md` with the same inline-artifacts harness note as
codex-hook), scenarios, mutation injection, and scorer-v2 audit parsing as the
other two runs. Registries are the same honest minted stubs.

## Results

**144 trials (n=48/arm: 32 drift + 16 clean), zero malformed, zero hop failures:**

| Condition | Gate detection | Drift halted | Shipped despite drift | Clean success | Task success |
| --------- | -------------- | ------------ | --------------------- | ------------- | ------------ |
| off       | —              | 14/32        | 18/32 (56%)           | 16/16         | 30/48 (63%)  |
| warn      | 32/32 (100%)   | 7/32         | **25/32 (78%)**       | 16/16         | 23/48 (48%)  |
| enforce   | 32/32 (100%)   | **32/32**    | 0                     | 16/16         | **48/48**    |

## The three-harness picture

Same relay, same scenarios, same gate verdicts, three harnesses and three
model families:

| Harness / model            | Gate tier | Warn: detection | Warn: shipped anyway | Enforce: drift halted | False blocks |
| -------------------------- | --------- | --------------- | -------------------- | --------------------- | ------------ |
| Claude Code / haiku        | hook      | 40/40           | 5/40 (12.5%)         | 40/40                 | 0            |
| OpenAI Codex / luna low    | hook      | 32/32           | 9/32 (28%)           | 32/32                 | 0            |
| Cursor CLI / composer-fast | wrapper   | 32/32           | 25/32 (78%)          | 32/32                 | 0            |

- **Detection is constant.** The gate caught every drifted ref in every
  harness — extraction and verdicts live once, in `sema check`, and behave
  identically everywhere.
- **Voluntary compliance is a model-dependent variable spanning 12.5% to
  78%.** Composer-fast read the repair text at the top of its prompt and
  shipped the drifted work in 25 of 32 relays. Whatever a team's tolerance
  for shipped drift, a warning tier cannot promise it.
- **Enforcement is deterministic in all three: 104/104 drifted relays
  halted, zero false blocks on clean refs in 300+ gated trials.** In the
  wrapper tier it is deterministic by construction (the agent is never
  invoked); the clean arms still measure the gate's false-block rate on real
  payloads, which stayed zero.
- The warn arm here had **zero false halts** (16/16 clean success) —
  composer-fast under-halts across the board, which is exactly why its warn
  leak is the worst of the three.

## Caveats

- Exploratory: no preregistration, one model, one run.
- The warn channel differs from the hook-based runs (prompt-prepension vs
  hook-stdout context injection); the 78% leak is therefore not a pure
  model-to-model comparison with the other two warn arms, though the warning
  content was identical and maximally adjacent to the task.
- Wrapper-tier enforce halts are deterministic by construction; the enforce
  arm's contribution here is the zero-false-block measurement, not the halt
  rate.
- Cursor hook dispatch may open up (it is a server flag); the natural
  follow-up is rerunning this experiment with the in-harness hook tier once
  it does.
- Conflict-of-interest disclosure: as with the other hook experiments, the
  author also wrote the gate under test and collaborates on sema. See the
  repo README's independence section.

## Reproducing

```bash
# Registry (honest minted stubs, same as babel-hook)
SEMA_REPO=/path/to/sema python3 ../babel-hook/build_dbs.py

# The run (cursor-agent logged in; composer-2.5-fast)
CANON_DB=/path/to/canon.db \
SEMA_PYTHON=/path/to/sema/.venv/bin/python \
python3 multihop.py > multihop-summary.txt 2> multihop-progress.log
```

Raw records live in `records/2026-07-20-composer/`: per-trial JSONL, run
summary, progress log, and per-trial `sema check` verdict logs (`gatelogs/`).
