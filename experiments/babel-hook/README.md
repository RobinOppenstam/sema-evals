# Babel Hook

> **Exploratory pilot. Not preregistered, not confirmatory evidence.**
> Single model family (claude-haiku-4-5 via the Claude Code CLI), small n,
> run 2026-07-18. Published for transparency and as design input for a
> proposed upstream enforcement hook.

Babel Hook replays the babel-relay drift scenarios through **real Claude Code
sessions** with a content-addressed ref gate installed as a harness hook. Where
[babel-relay](../babel-relay/) implements verification and enforcement inside
its own TypeScript harness, this experiment asks whether the same mechanism
works when enforcement lives where production agents actually run: a Claude
Code `UserPromptSubmit` hook that scans each hop's inbound message for
`Handle#stub` refs, verdicts them against a sema registry, and — depending on
mode — warns or refuses delivery.

The gate under test is `hooks/ref_gate.py` from
[RobinOppenstam/sema@`feat/claude-hook-ref-gate`](https://github.com/RobinOppenstam/sema/tree/feat/claude-hook-ref-gate)
(published runs used commit `b00e062`).

## Design

Three-boundary relay, mirroring babel-relay's model pilot:
`spec-to-plan → plan-to-implementation → implementation-to-audit`, using the
**frozen boundary prompts** from `experiments/babel-relay/prompts/`
(snapshot 2026-07-14.2, read-only) as system prompts and the babel-relay
scenario fixtures (4 drift + 2 no-drift controls). The audit hop's verdict is
parsed with the babel-relay scorer-v2 convention (markdown-tolerant
`DECISION: PROCEED|HALT`, last matching line wins).

Conditions differ **only** in the gate mode (`SEMA_REF_GATE`):

| Condition | Gate behavior | Babel-relay analog |
| --- | --- | --- |
| `off` | hook exits immediately | addressed transport, no verification |
| `warn` | STALE verdict injected as model-visible context, never blocks | addressed-voluntary |
| `enforce` | STALE ref blocks the hop (exit 2), relay halts | addressed-enforced |

All three conditions use the identical transport: content-addressed ref plus
hydrated definition in every hop message.

Refs are honest content hashes: each scenario's canonical and mutated
definitions are minted through sema's real mint pipeline (`build_dbs.py`) into
`canon.db` (the gate's registry) and a throwaway `mut.db` (source of drifted
stubs). One deliberate deviation from upstream babel-relay: the wire carries
the reference **of the definition as relayed** (canonical stub before the
mutation boundary, mutated stub after), rather than upstream's design where the
wire always carries the canonical ref and the harness verifies out of band.
The content-derived wire ref is what exposes drift to a gate that only sees
messages — that is the mechanism under test.

Enforced halts occur **before the model call**: a blocked first-boundary trial
runs zero model hops, mirroring babel-relay's "enforced halts skip downstream
calls".

## Results

Model: `claude-haiku-4-5` via `claude -p` (CLI 2.1.214, subscription auth,
`--tools ""`, `--strict-mcp-config`, `--no-session-persistence`). Trials
interleave conditions so interrupted runs stay balanced.

**Pooled multi-hop runs (run36 + run144 = 180 trials; n=60/arm: 40 drift + 20 clean):**

| Condition | Detection (drift) | Silent divergence | Drift halted | Task success | Gate false blocks |
| --- | --- | --- | --- | --- | --- |
| off | 12/40 (30%) | 28/40 (70%) | 12/40 | 29/60 (48%) | — |
| warn | 40/40 (100%) | 0/40 | 35/40 (87.5%) | 50/60 (83%) | 0 |
| enforce | 40/40 (100%) | 0/40 | **40/40 (100%)** | 57/60 (95%) | 0 |

Key observations:

- **The voluntary leak is real in a live harness.** In `warn`, the gate
  detected every drifted ref and injected the warning at every hop — and the
  relay still shipped drifted work in 5/40 trials (12.5%), spread across three
  scenarios and different reps. Detection was 100% in all five leaks: the
  model knew and proceeded anyway.
- **Enforcement closed all 40/40, deterministically and at zero downstream
  cost** (`audit=None` on every enforced drift trial — no model calls after
  the block; typical blocked-hop latency ~2.5s).
- **The gate itself produced zero false blocks.** Clean-control false halts
  (3/5/3 of 20 per arm) come from the audit agent occasionally halting
  unnecessarily — the same noise floor in all arms, unaffected by the gate.
- A separate single-hop pilot (60 trials, `run_ab.py`,
  `singlehop-*.jsonl/txt`) showed warn at ceiling (8/8 halted) — the
  warn/enforce gap only appears once the task is multi-hop, consistent with
  babel-relay's addressed-voluntary findings.

## A finding about where scan logic should live

The first smoke run let a stale ref through: Claude Code hook payloads are
JSON, so newlines inside strings arrive escaped as literal `\n`, which
destroys the regex `\b` word boundary for any ref at a line start
(`...\nInclusivePaymentThreshold#ae2d` — the `n` fuses with the handle). The
fix scans decoded JSON string values instead of raw wire bytes. This is an
argument for ref extraction living once, upstream (a `sema check` primitive),
rather than being reimplemented per harness shim.

## Caveats

- Exploratory: no preregistration, one model family, modest n, no
  order-seed randomization beyond condition interleaving.
- The warn condition injects the warning directly adjacent to the task at
  every hop — a best case for voluntary compliance. The 12.5% leak is
  therefore likely a lower bound.
- Trials share one Claude Code user environment (user-level settings load in
  every session); identical across arms, but not a hermetic sandbox.
- An aborted earlier 306-trial run contributed no scored trials
  (condition-ordered, off-arm only; archived as `off-partial-run1.log`,
  directionally consistent).
- Conflict-of-interest disclosure: the author of this experiment also wrote
  the gate hook under test and collaborates on sema itself. Preregistration
  and raw records — not org separation — carry the evidential weight here,
  and this pilot claims only exploratory status.

## Reproducing

```bash
# 1. Registries (needs a sema checkout with a built .venv)
SEMA_REPO=/path/to/sema python3 build_dbs.py

# 2. Multi-hop run (needs the ref-gate branch checked out in $SEMA_REPO)
SEMA_PYTHON=$SEMA_REPO/.venv/bin/python \
SEMA_REF_GATE_PATH=$SEMA_REPO/hooks/ref_gate.py \
python3 multihop.py > summary.txt 2> progress.log
```

Raw records for the published runs live in
`results/public/babel-hook/2026-07-18-haiku/`: per-trial JSONL for both multi-hop
runs and the single-hop pilot, run summaries, progress logs, minted stubs
(`stubs.json`), and per-trial gate verdict logs (`gatelogs/`, run144;
run36 gate logs were not retained).
