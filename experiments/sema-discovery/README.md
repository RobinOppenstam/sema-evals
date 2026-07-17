# Sema discovery and session reuse

Deterministic scaffold for the Sema-native sequence:

`search → select → resolve dependencies → execute → reuse within session`

Five paired conditions keep discovery separate from preselected delivery:

- `task-only`
- `preselected-prose`
- `preselected-addressed`
- `discovery`
- `discovery-reuse`

The discovery arms receive no gold handle. Search parameters, ranking,
tie-breaking, dependency traversal, and session reset behavior are frozen and
fingerprinted. Every trial starts with an empty session; only
`discovery-reuse` may reuse the first task's prepared dependency closure on the
second task.

Run:

```bash
pnpm experiment:prepare
pnpm experiment:sema-discovery
```

The bundled catalog and scripted executor validate mechanism and measurement
only. They are not evidence that a real model can discover useful patterns or
that a pattern library improves workflow performance. No live model or network
provider is wired.
