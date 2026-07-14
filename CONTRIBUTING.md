# Contributing

Start by reading [AGENTS.md](AGENTS.md) and
[docs/EXPERIMENT_STANDARD.md](docs/EXPERIMENT_STANDARD.md).

## Development

```bash
pnpm install
pnpm check
```

Experiment changes should include:

1. A falsifiable hypothesis.
2. A declared primary endpoint.
3. Equal-information controls or a written reason they are impossible.
4. At least one clean negative/control fixture.
5. Objective tests for the scorer.
6. A protocol version bump when scoring or condition behavior changes.

Generated results are ignored by default. Promote a result only through a
separate, dated report that includes its manifest and raw data provenance.

Use conventional commit subjects where practical, for example:

```text
feat(babel): add timeout-boundary mutation family
fix(core): preserve failed trials in matrix output
docs(protocol): preregister hydration-byte endpoint
```
