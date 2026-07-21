# Cursor Hook

> **Exploratory pilots. Not preregistered, not confirmatory evidence.**
> Third harness in the series after [babel-hook](../babel-hook/) (Claude
> Code) and [codex-hook](../codex-hook/) (OpenAI Codex). Two run sets:
> the original composer-2.5-fast run (2026-07-20) and a four-model
> **warn-leak isolation** set (2026-07-21/22) that swaps only the model
> through the identical wrapper gate.

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

## Results — composer-2.5-fast (2026-07-20)

**144 trials (n=48/arm: 32 drift + 16 clean), zero malformed, zero hop failures:**

| Condition | Gate detection | Drift halted | Shipped despite drift | Clean success | Task success |
| --------- | -------------- | ------------ | --------------------- | ------------- | ------------ |
| off       | —              | 14/32        | 18/32 (56%)           | 16/16         | 30/48 (63%)  |
| warn      | 32/32 (100%)   | 7/32         | **25/32 (78%)**       | 16/16         | 23/48 (48%)  |
| enforce   | 32/32 (100%)   | **32/32**    | 0                     | 16/16         | **48/48**    |

## Results — warn-leak model isolation (2026-07-21/22)

The three-harness comparison left a confound: every run changed model *and*
harness at once, so the 12.5%→78% warn-leak spread could not be attributed to
either. These runs remove it: the **same wrapper, same frozen prompts, same
registry, same gate** — only `--model` varies. 144 trials per model.

**Warn leak** = drifted relays where the gate detected the stale ref and
injected its warning, but the relay still shipped (hop failures excluded).

| Model (via Cursor CLI)     | Warn: detection | Warn leak       | Off: drift caught unaided | Enforce: drift halted | Gate false blocks |
| -------------------------- | --------------- | --------------- | ------------------------- | --------------------- | ----------------- |
| gemini-3.5-flash           | 29/29           | **1/29 (3%)**   | 7/27 (26%)                | 29/29                 | 0                 |
| kimi-k2.7-code             | 29/29           | **6/29 (21%)**  | 6/28 (21%)                | 28/28                 | 0                 |
| gpt-5.4-nano-low           | 24/24           | **10/24 (42%)** | 9/23 (39%)                | 25/25                 | 0                 |
| composer-2.5-fast (rerun)  | 31/31           | **18/31 (58%)** | 14/32 (44%)               | 31/31                 | 0                 |
| composer-2.5-fast (07-20)  | 32/32           | **25/32 (78%)** | 14/32 (44%)               | 32/32                 | 0                 |

- **Warn-mode leak is a model property, not a channel property.** A 3%-to-78%
  spread through an identical injection mechanism settles the trilogy's open
  question: the warn channel delivers the warning fine; models differ
  enormously in whether they heed it.
- **The composer rerun replicates the finding's direction, not its exact
  size.** 58% leak vs the original 78% (18/31 vs 25/32) — noisy at this n,
  but composer stays the leakiest model tested by a wide margin, and its
  unaided off arm reproduced exactly (14/32 in both runs).
- **Enforcement is the invariant.** Every drifted relay halted in every
  enforce arm, and the gate never false-blocked a clean payload in any run.
- **Unaided, cheap models are drift-blind.** Without the gate, audits caught
  drift 21–39% of the time (61–79% silent divergence). At the cheap end the
  gate is not an assist; it is the only detection that works.
- Data quality: gpt-5.4-nano-low degraded badly (47/144 hop timeouts, 20
  malformed audits, 18 audit-noise false halts on clean controls — echoing
  haiku's `refund-recipient-control` pattern); treat its leak estimate as
  low-confidence. kimi's warn arm had elevated timeouts (15/48 vs 8–9
  elsewhere). gemini-3.5-flash was clean throughout.

Raw records: `records/2026-07-21-{flash,kimi,nano}/` and
`records/2026-07-22-composer-rerun/` (same layout as the composer run).

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

- Exploratory: no preregistration, one run per model.
- The warn channel differs from the hook-based runs (prompt-prepension vs
  hook-stdout context injection), so cross-harness warn comparisons are not
  pure model-to-model comparisons. The model-isolation set addresses this
  *within* Cursor: those four warn arms share an identical channel and differ
  only in model.
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

# The run (cursor-agent logged in; CURSOR_MODEL defaults to composer-2.5-fast)
CURSOR_MODEL=gemini-3.5-flash \
CANON_DB=/path/to/canon.db \
SEMA_PYTHON=/path/to/sema/.venv/bin/python \
python3 multihop.py > multihop-summary.txt 2> multihop-progress.log
```

Raw records live under `records/` (one directory per run): per-trial JSONL,
run summary, progress log, and per-trial `sema check` verdict logs
(`gatelogs/`).
