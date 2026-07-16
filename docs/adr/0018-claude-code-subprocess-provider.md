# ADR 0018: Claude Code subprocess model provider

- Status: accepted
- Date: 2026-07-16

## Context

Babel Relay model pilots today require a metered API key (`ANTHROPIC_API_KEY`
or an OpenAI-compatible endpoint key). The repository owner also has a Claude
subscription that authenticates the locally installed Claude Code CLI. Running
exploratory (and, when explicitly preregistered, confirmatory) arms through that
subscription avoids spending API credits while still exercising the same
transcript-preserving adapter contract as ADR 0005 / ADR 0007.

Claude Code is not a raw Messages API. Every `-p` call passes through Claude
Code's own scaffolding (session machinery, default tool surface unless disabled,
CLI-owned prompt assembly). That harness layer is an experimental confound and
must be named honestly: a result obtained through this provider is evidence
about "model + Claude Code CLI harness", not about the raw Anthropic API.

## Decision

### `ClaudeCodeModelAdapter` as a first-class sibling provider

A new `ClaudeCodeModelAdapter` in `@sema-evals/adapters` implements the same
`ModelAgentAdapter<ModelPromptInput, ModelCompletion>` interface as the
Anthropic and OpenAI-compatible adapters. Every attempt — success, refusal,
truncation, nonzero exit, malformed JSON, or timeout — is appended to the
transcript with its raw payload. `invoke` never throws for provider outcomes.
Retries are adapter-level, bounded exponential backoff, and fire only on
timeouts and spawn/connection failures (ADR 0008); nonzero exits and malformed
JSON are non-retryable preserved failures.

### Invocation shape

Each call spawns the configured binary (default `claude`) with:

- `-p <prompt>` — headless print mode, single non-interactive turn
- `--output-format json` — single JSON result on stdout
- `--model <id>` — target model slug
- `--system-prompt <text>` — replaces the CLI default system prompt with the
  experiment's frozen boundary prompt
- `--tools ""` — disables all built-in tools
- `--no-session-persistence` — does not write a resumable session

Stdin is ignored so the CLI does not wait for piped input. The subprocess is
killed with `SIGKILL` when `timeoutMs` elapses (default 120_000).

`--bare` is deliberately **not** used: it forces Anthropic auth to
`ANTHROPIC_API_KEY` / `apiKeyHelper` and disables OAuth/keychain, which would
defeat the subscription-funded motivation.

### What is and is not controllable

| Surface                                      | Controllable?  | Mechanism                                                       |
| -------------------------------------------- | -------------- | --------------------------------------------------------------- |
| System prompt                                | Yes            | `--system-prompt` (full override, not append)                   |
| User prompt                                  | Yes            | `-p` argument (multi-turn inputs are flattened into one string) |
| Model id                                     | Yes            | `--model`                                                       |
| Tools                                        | Yes (disabled) | `--tools ""`                                                    |
| Session persistence                          | Yes (off)      | `--no-session-persistence`                                      |
| `max_tokens`                                 | **No**         | No print-mode flag; config accepted for interface parity only   |
| Sampling (`temperature` / `top_p` / `top_k`) | **No**         | No flags; never sent (matches repo stance)                      |
| Adaptive thinking                            | **No**         | No equivalent to Messages `thinking: { type: "adaptive" }`      |
| CLI scaffolding beyond the flags above       | **No**         | Inherent to Claude Code                                         |

### Telemetry mapping (gaps recorded as null, never fabricated)

JSON fields observed on Claude Code 2.1.x print-mode success results:

- `result` → completion text
- `stop_reason` → `stopReason` / status (`end_turn` completes; `max_tokens`
  truncates; `refusal` refuses; `is_error: true` forces `error`)
- `usage.input_tokens` / `output_tokens` /
  `cache_read_input_tokens` / `cache_creation_input_tokens` → matching usage
  fields (absent → 0)
- `total_cost_usd` → `costUsd` (available here; null on the raw API adapters)
- `reasoningTokens` → always `null` (CLI does not report them)

### Provenance: pin the CLI version

`resolveCliVersion()` runs `claude --version` once per adapter instance. The
babel-relay CLI records provenance `modelProvider` as
`claude-code@<version-string>` (for example `claude-code@2.1.211 (Claude Code)`)
and `modelName` as the exact `--model` slug. Reproducers need that pin: the CLI
is itself a moving harness between the frozen prompt and the model.

No API key env var is required or read. Subscription auth is ambient in the
installed CLI. The CLI exposes `--claude-bin <path>` (default `claude`).

### Concurrency

Each call is an independent subprocess. The harness `--concurrency` option is
unchanged (ADR 0008); this adapter adds no pooling beyond what the other
providers already do.

### Preregistration requirement

The provider layer is outside the preregistration freeze, but **any confirmatory
use of this provider must name `claude-code` explicitly in the preregistration**
(including the CLI version-pinning convention above). A preregistration written
for `anthropic` or `openai-compatible` must not silently run on Claude Code.

### Testing

Unit tests drive a stub executable that mimics print-mode JSON, nonzero exits,
garbage stdout, and hang-until-timeout. No live `claude` calls run in CI.

## Consequences

- Experiment arms can run against the owner's Claude subscription without a
  metered API key, selectable as `--provider claude-code`.
- Results carry an explicit harness caveat and a pinned CLI version in
  provenance; they are not interchangeable with raw Anthropic Messages evidence.
- Telemetry gaps (`reasoningTokens`, uncontrollable `max_tokens` / thinking)
  are documented and recorded as null rather than guessed.
- Confirmatory designs that want this path must preregister it by name.
