# ADR 0019: Shared subscription CLI harness adapters

- Status: accepted
- Date: 2026-07-16

## Context

The repository already supported direct Anthropic and OpenAI-compatible API
calls, plus a Claude Code subprocess adapter. The owner also has authenticated
Codex, Grok Build, Cursor Agent, and OpenCode installations. Future experiments
should not need to implement another provider-specific subprocess wrapper, and
the existing model-capable experiments should expose the same provider surface.

These CLIs are not interchangeable raw-model transports. Each adds its own
system scaffolding, context discovery, tool policy, session behavior, model
routing, and telemetry. Treating a Codex subscription run as equivalent to a
raw OpenAI API call, for example, would confound model effects with harness
effects.

## Decision

### One provider registry and factory

`@sema-evals/adapters` exports:

- `MODEL_PROVIDERS` / `ModelProvider`;
- provider capability predicates;
- `createModelProvider`;
- `CliHarnessModelAdapter`; and
- provider-specific argument builders and output parsers.

The registry includes `anthropic`, `openai-compatible`, `claude-code`,
`codex-cli`, `grok-build`, `cursor-agent`, and `opencode`. Babel Relay, A2A
Drift, and both Sema Tax model-pilot arms construct adapters through this
factory. A future experiment should depend on the same factory rather than
switching directly on provider names.

### Headless invocation controls

| Provider     | Headless path                               | System prompt delivery | Tool policy                           | Session policy              |
| ------------ | ------------------------------------------- | ---------------------- | ------------------------------------- | --------------------------- |
| Claude Code  | `claude -p --output-format json`            | full override          | disabled                              | persistence disabled        |
| Codex CLI    | `codex exec --ephemeral --json`             | prompt envelope        | read-only sandbox                     | ephemeral                   |
| Grok Build   | `grok --single --output-format json`        | full override          | disabled                              | provider-managed, no memory |
| Cursor Agent | `cursor-agent --print --output-format json` | prompt envelope        | ask mode, sandbox enabled             | provider-managed            |
| OpenCode     | `opencode run --format json --pure`         | prompt envelope        | all permissions denied through config | provider-managed            |

For harnesses without a documented system-prompt override, the frozen
experiment system prompt is placed in a clearly delimited prompt envelope.
That is a different implementation from a true system message and is recorded
as such.

All subprocesses run in an isolated, normally empty workspace under
`results/.harness-workspace` by default. This prevents repository files,
`AGENTS.md`, and project-specific instructions from leaking into a trial.
Operators may override the binary and workspace with `--harness-bin` and
`--harness-cwd`; both values are recorded in the result manifest.

### Preservation and telemetry

The shared adapter:

- preserves success, refusal, truncation, timeout, malformed output, and
  nonzero exit results;
- retries only subprocess spawn failures and timeouts with bounded backoff;
- caps preserved stdout/stderr;
- records raw provider output and a transcript entry for every attempt;
- maps only telemetry the CLI actually reports; and
- records the exact CLI version in `modelProvider`, for example
  `codex-cli@codex-cli 0.144.5`.

Missing usage channels are zero/null in the normalized trial telemetry, never
estimated from text. Wire bytes, hydration/context tokens, and provider model
tokens remain separate experiment metrics.

### Research status

Subscription harness results are evidence about the named
`model + CLI harness + CLI version` implementation. They are not raw-provider
comparisons. Cross-harness comparisons are exploratory unless the harness,
version-pinning rule, prompt-delivery mechanism, model selector, tool policy,
primary endpoint, and exclusions were preregistered.

The existing Babel confirmatory freeze remains unchanged. A preregistration
that names `openai-compatible` cannot be silently executed through a
subscription harness.

## Consequences

- Every current model-capable experiment can use every registered harness.
- New experiments get the same providers by consuming one factory.
- CLI version drift and harness behavior remain explicit experimental
  implementation effects.
- Security, forecasting, and x402 still need experiment-specific model
  executors before they can run model pilots; they do not need new provider
  adapters when those executors are added.
