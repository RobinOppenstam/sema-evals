# ADR 0008: Bounded trial concurrency, request timeouts, and progress output

- Status: accepted
- Date: 2026-07-14

## Context

The first live instrumentation run (Gemma on Chutes, ADR 0007's
openai-compatible adapter) exposed three operational problems:

1. **Sequential throughput.** `executeMatrix` ran trials strictly one at a time.
   Each model call took ~95s — roughly 36s of that is provider queue latency
   before generation even starts — so a 150-trial run projected to ~10 hours of
   mostly idle waiting on the network.
2. **No request ceiling.** The openai-compatible adapter's `fetch` had no
   timeout. A single stalled provider instance would hang the entire run
   forever, with no way to recover short of killing the process.
3. **A black-box run.** The CLI printed the planned shape at start and the
   summary at finish, and nothing in between. A multi-hour run gave no signal
   that it was alive or how far along it was.

## Decision

### Bounded trial concurrency in `executeMatrix`

`executeMatrix` gains an `ExecuteMatrixOptions.concurrency` (default `1` —
existing behavior is byte-for-byte unchanged). A bounded worker pool keeps at
most N trials in flight. Workers claim the lowest not-yet-started cell index;
because claiming the index happens before the first `await` on the single JS
thread, the claim is atomic and **trials are always STARTED in planned order**.

The returned array is **always in planned order**: `records[i]` is the result
of `cells[i]`, regardless of the order trials actually complete in. Completion
order under concurrency is nondeterministic (it depends on provider timing), so
binding the returned array to completion order would make it nondeterministic.
Binding it to the plan keeps every downstream consumer — bundle writer,
reporters, analysis — deterministic given the plan. An optional `onComplete`
callback fires once per trial in completion order, for progress reporting only;
it must not be relied on for ordering.

The CLI exposes this as `--concurrency <n>` (default 1, min 1, max 32,
validated). It is only meaningful in model-pilot mode, where trials wait on a
network provider. In deterministic mode — local, CPU-bound — a value above 1 is
ignored with a note to stderr and the run proceeds sequentially. Concurrency is
included in the model-pilot spend/shape printout.

### Why this does not violate the randomized-order discipline

`docs/EXPERIMENT_STANDARD.md` requires that condition order be shuffled by a
recorded order seed and that provider retry policy not selectively drop
inconvenient outputs. Bounded concurrency preserves all of this:

- **Start order still follows the seed.** `planPairedMatrix` fixes the
  execution order from the order seed; the worker pool starts trials in exactly
  that order. Concurrency changes only how many are in flight at once, not which
  starts next.
- **Paired scenario/seed blocks are untouched.** Concurrency is orthogonal to
  planning: the same cells run in the same planned positions, each carrying its
  `executionIndex`.
- **Per-trial records timestamp actual execution.** Each record already carries
  `startedAt`/`completedAt`; under concurrency these honestly reflect the
  overlapping wall-clock windows, so the real execution timeline is recoverable
  from the bundle. No schema change is needed.
- **Retry policy is unchanged.** Bounded per-adapter retries still fire only on
  429/5xx/connection errors and every attempt is still preserved.

### Per-request timeouts in both adapters

- **openai-compatible adapter:** a `timeoutMs` config (default 120_000) drives
  `AbortSignal.timeout` on every attempt. The signal is threaded through the
  injectable `fetchFn` (via an optional `OpenAiFetchInit.signal`) so the Node
  built-in `fetch` honors it and test fakes can observe or ignore it. A timeout
  abort is a **connection-class error**: it is recorded as an error attempt in
  the transcript and is retryable under the existing bounded-retry policy,
  exactly like a socket reset. A stalled instance now costs at most `timeoutMs`
  per attempt instead of hanging the run.
- **anthropic adapter:** a `timeoutMs` config (default 600_000, the SDK default)
  is passed to the SDK client at construction (`new Anthropic({ timeout })`).
  The SDK surfaces a timeout as a connection-style error, which the adapter
  already classifies as retryable.

### Progress output on stderr

In model-pilot mode the CLI prints a run-start line and then one line per
completed trial to **stderr**:

```text
trial <done>/<total> <scenarioId> <condition> seed=<n> -> <proceed|halt> [<taskSuccess|fail>] (<elapsed>s, <calls> calls)
```

`calls` is derived from the record's aggregated usage (`usage.attempts`, i.e.
provider attempts across the trial's model hops, retries included); a trial that
halted before any model hop reports zero. stdout stays reserved for the existing
machine-parseable summary, so piping and parsing are unaffected. Deterministic
mode stays silent, as before.

## Consequences

- A 150-trial Chutes pilot at `--concurrency 8` overlaps the ~36s-per-call queue
  latency across trials, cutting a ~10-hour run by close to an order of
  magnitude, without changing what is measured or how it is ordered.
- A stalled provider instance can no longer hang a run indefinitely; it fails a
  bounded attempt, is preserved, and is retried.
- Long runs are observable in real time on stderr without polluting the summary
  on stdout.
- Analysis remains deterministic given the plan: the returned/written record
  order is fixed to planned order regardless of provider timing, and each record
  timestamps its own execution window.
