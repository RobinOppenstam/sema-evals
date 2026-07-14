<div align="center">

# sema-evals

**Open, causal evaluations for content-addressed semantics and multi-agent coordination.**

_When meaning changes, do agents notice before they act?_

[![CI](https://github.com/RobinOppenstam/sema-evals/actions/workflows/ci.yml/badge.svg)](https://github.com/RobinOppenstam/sema-evals/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-111111.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933.svg?logo=node.js&logoColor=white)](package.json)
[![Research status](https://img.shields.io/badge/status-foundation_live-5B5BD6.svg)](docs/RESEARCH_PLAN.md)

[**Published results**](https://robinoppenstam.github.io/sema-evals/) · [Quick start](#quick-start) · [First experiment](#babel-relay) · [Research plan](docs/RESEARCH_PLAN.md) · [Contributing](CONTRIBUTING.md)

</div>

---

`sema-evals` is an independent companion to
[Sema](https://github.com/emergent-wisdom/sema), the content-addressed semantic
protocol for agent coordination.

It investigates one deliberately narrow question:

> Does content-addressed, fail-closed semantic alignment reduce silent
> coordination failures **after controlling for instruction quality**?

The distinction matters. A good Pattern Card may improve an agent because its
instructions are good. A hash may detect that two definitions differ. A runtime
may prevent execution after detecting that difference. Those are three separate
effects, and this project measures them separately.

## Babel Relay

The first runnable experiment passes a small contract through four boundaries
and injects one controlled semantic mutation—such as `>=` becoming `>`, six
token decimals becoming eighteen, or one retry becoming two.

```mermaid
flowchart LR
    S[Spec agent] --> P[Planner]
    P --> I[Implementation agent]
    I --> A[Auditor]
    M{{Controlled semantic drift}} -.-> P
    M -.-> I
    M -.-> A
    A -->|aligned| GO[Proceed]
    A -->|mismatch + enforcement| STOP[Halt]
```

Every fixture runs through the same five-condition ladder:

| Condition                               | Isolated comparison                    |
| --------------------------------------- | -------------------------------------- |
| **Task-only natural language**          | Ordinary baseline                      |
| **Equal-information prose**             | Benefit of the semantic content itself |
| **Opaque ID + resolver**                | Lookup and wire-compression control    |
| **Content-addressed + voluntary check** | Drift detection without enforcement    |
| **Content-addressed + enforced check**  | Fail-closed runtime enforcement        |

The default backend uses deterministic fixture references. It validates the
experiment mechanics, objective scorer, paired randomization, and result
pipeline. The optional official backend now mints isolated Sema vocabularies,
hydrates definitions through `GraphWorkspace`, and records real
`PROCEED`/`HALT` handshake payloads. Neither mode is an empirical claim that
Sema improves model performance.

The first model pilot is now wired in. A `model-pilot` run mode replays the same
three boundaries through a transcript-preserving model adapter — one per
boundary, using the frozen, digest-verified prompt snapshots — with objective
`DECISION: PROCEED` / `DECISION: HALT` parsing rather than an LLM judge,
per-trial usage aggregated across hops, and preserved failures. Two provider
families are supported behind one interface: a first-party Anthropic adapter and
an `OpenAiCompatibleModelAdapter` that drives any OpenAI-compatible endpoint
(targets Chutes) over the Node built-in `fetch` for cheap exploratory
cross-family signal. It is labelled exploratory in its result manifest, requires
the selected provider's API key, prints its spend shape before running, and never
runs in CI. No live pilot has been executed yet; running it is an operator
decision. See [the Babel Relay README](experiments/babel-relay/README.md) and
[ADR 0007](docs/adr/0007-openai-compatible-provider-adapter.md).

## Quick start

Requirements: Node.js 22+ and pnpm 10+.

```bash
git clone https://github.com/RobinOppenstam/sema-evals.git
cd sema-evals
pnpm install
pnpm check
pnpm experiment:babel
```

Run five paired repetitions with a recorded order seed:

```bash
pnpm experiment:babel -- --seeds 5 --order-seed 20260714
```

Use official Sema v0.3 canonicalization from an adjacent upstream checkout:

```bash
pnpm experiment:babel -- \
  --semantic-backend sema-python \
  --sema-python ../sema/.venv/bin/python \
  --seeds 5
```

The selected Python interpreter must have `semahash>=0.3.0,<0.4.0` installed.
The adapter deliberately fails closed outside the audited 0.3.x line rather
than guessing which canonicalization a future release uses. Its package and
canonicalization versions are written into every result manifest. The
TypeScript harness does not reimplement or approximate Sema hashing, registry
resolution, vocabulary roots, or handshake verdicts.

Official runs create temporary private registries with explicit absolute paths.
They never change `~/.config/sema/active_db`, and they remove the registries
after the result bundle is written. Registry setup and Python startup happen in
preflight, so current `elapsedMs` values are not handshake-latency measurements.

The command produces a complete, ignored result bundle:

```text
results/babel-relay/<run-id>/
├── manifest.json    # environment, protocol, model, and data fingerprints
├── trials.jsonl     # one lossless record per trial
├── summary.json     # machine-readable aggregates
└── summary.md       # human-readable condition comparison
```

## What gets measured

Outcome metrics:

- silent semantic-divergence rate;
- correct and false halt rates;
- final task success;
- detection boundary and repair outcome;
- variance across paired repetitions.

Cost metrics remain separate:

- bytes transmitted on the wire;
- bytes or tokens hydrated by a resolver;
- cached and uncached model input tokens;
- output and reasoning tokens when available;
- tool calls, latency, retries, and monetary cost.

A four-character reference may compress a message while the full definition
still enters model context. `sema-evals` never treats those as the same saving.

## Repository map

```text
packages/
├── core/             versioned schemas, fingerprints, matrix runner, prompt loader
├── adapters/         provider-neutral agents, transcript-preserving model adapter, Sema Python bridge
└── reporters/        JSONL, JSON, and Markdown result bundles

experiments/
├── babel-relay/      runnable controlled semantic-drift experiment
│   └── prompts/      frozen, digest-verified prompt snapshots for the model pilot
├── sema-tax/         pattern-count and hydration break-even curve
├── security/         mutation-backed smart-contract evaluation
├── forecasting/      historical five-agent forecast council
└── x402-contract-drift/ payment and delegation semantics

docs/
├── RESEARCH_PLAN.md
├── EXPERIMENT_STANDARD.md
└── adr/              durable research and architecture decisions

scripts/              schema generation, report promotion, and static-site build
├── promote-report.ts a run bundle into a tracked public derivative
├── build-site.ts     the static public report site from promoted bundles
└── lib/              redaction, aggregation, and HTML rendering (unit-tested)

schemas/              generated public JSON Schemas
results/              local generated artifacts, ignored by default
└── public/           deliberately promoted public derivatives (tracked)
site/dist/            generated static report site, ignored by default
```

The reusable [adapter package](packages/adapters/README.md) exposes typed
official-Python clients for reference generation, isolated registry builds,
resolution, and pattern or vocabulary handshakes.

## Public reports

Published run reports live at
**<https://robinoppenstam.github.io/sema-evals/>**.

Result bundles under `results/` are untracked by default. Publishing is a
deliberate act: a bundle is _promoted_ into a tracked, redacted public
derivative, and a static site is generated from those derivatives and deployed
to GitHub Pages. Nothing is published as a side effect of running an experiment.

```bash
# 1. Promote a local run bundle into results/public/<experimentId>/<runId>/
pnpm report:promote -- results/babel-relay/<runId>
#    Add --force to replace an already-promoted run.

# 2. Build the static site into site/dist/ (recomputes every statistic)
pnpm site:build
```

Promotion validates the manifest against `resultManifestSchema` and writes a
**public derivative**: `manifest.json` and `summary.json` verbatim, plus
`trials.public.jsonl` — the trial records with each transcript entry's raw
provider payload stripped (`raw: null`) and each content block's text capped at
20,000 characters. Full raw bundles are retained locally only. A `PROMOTED.md`
records the source directory and the redaction rules.

The site is plain generated HTML with inline CSS and inline SVG charts — no
frontend framework and no runtime dependencies. Every rate and count shown is
**recomputed from `trials.public.jsonl` at build time**; the committed
`summary.json` is cross-checked and disagreements are printed as build warnings
rather than trusted. Each run is labelled by mode
(`deterministic-harness` / `model-pilot` / `confirmatory`) structurally, and a
model pilot renders its manifest `evidenceClaim` verbatim so an exploratory run
can never be mistaken for confirmatory evidence. See
[ADR 0009](docs/adr/0009-static-public-report-site.md) for the rationale.

On push to `main`, `.github/workflows/pages.yml` builds the site and deploys it
to GitHub Pages. Enabling Pages (Settings → Pages → Source: GitHub Actions) is a
one-time operator action.

## Research roadmap

| Phase | Deliverable                                   | Primary endpoint               | Status          |
| ----- | --------------------------------------------- | ------------------------------ | --------------- |
| 0     | Reproducible evaluator + deterministic relay  | Scorer correctness             | **Live**        |
| 1     | Registry handshake + model-driven Babel Relay | Silent-divergence rate         | **In progress** |
| 2     | Sema tax and hydration curve                  | Success per total token        | Planned         |
| 3     | A2A semantic extension                        | Execution under registry drift | Planned         |
| 4     | `sema-sec` Solidity trials                    | Recall at fixed FP budget      | Planned         |
| 5     | Historical forecast council                   | Brier score                    | Planned         |

The full sequence and exit gates are locked in the
[research plan](docs/RESEARCH_PLAN.md). Material changes require an architecture
decision record rather than silently moving the goalposts.

## Experiment contract

Evidence published from this repository should satisfy these constraints:

1. Choose one primary endpoint before a confirmatory run.
2. Give causal controls identical semantic information, tools, and budgets.
3. Run every condition on the same scenario and seed blocks.
4. Record the condition-order randomization seed.
5. Prefer executable validators over subjective judging.
6. Preserve malformed outputs, failures, timeouts, and exclusions.
7. Fingerprint code, prompts, fixtures, models, Sema, and dependency locks.
8. Publish negative results and uncertainty—not only winning examples.

See the complete [experiment standard](docs/EXPERIMENT_STANDARD.md).

## Working with upstream Sema

This repository does not fork or silently patch the protocol. During local
development, the repositories can sit side by side:

```text
projects/opensource/
├── sema/          upstream protocol checkout
└── sema-evals/    independent experiments and evidence
```

Potential Pattern Cards, conformance vectors, or protocol integrations can be
proposed upstream after they have focused tests and maintainer alignment.

## Contributing

Small, falsifiable additions are preferred over large agent demos. Good first
contributions include:

- a new Babel Relay mutation plus a clean control;
- an objective scorer invariant;
- a persistent Sema sidecar with explicit cold/warm latency telemetry;
- a provider adapter that preserves raw responses and usage telemetry;
- cross-language canonicalization test vectors;
- reproducible analysis or visualization of an existing result bundle.

Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md) before opening a change.

## License and attribution

Code in this repository is MIT licensed. Sema vocabulary, documentation, or
other content copied or derived here remains subject to Sema's CC BY 4.0
content license. See [NOTICE](NOTICE).

`sema-evals` is independent research infrastructure and is not an official Sema
release.
