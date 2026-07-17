# Workflow corpus acquisition

This directory contains the evidence protocol for repository-task acquisition.
The files in `templates/` are machine-readable blank forms, not completed
reviews. A task is accepted only after all six task reviews pass, the
deduplication report passes, the offline workspace replays, the hidden validator
fails before the fix and passes afterward, and reset produces the exact sealed
pre-fix directory digest. Acquisition and validator reviews must be performed by
different reviewers.

`candidate-repositories.yaml` records the primary repository and license
screening plus the four accepted sacrificial task IDs. `residual-gate.yaml`
records that the three-task Phase 2 threshold is satisfied. Neither file is a
held-out or confirmatory evidence claim.

The corpus seal command runs from the repository root:

```sh
pnpm --filter @sema-evals/workflow-value corpus:seal -- \
  --manifest datasets/manifests/<manifest>.yaml \
  --root ../.. \
  --output datasets/seals/<manifest>.json
```

Verify a promoted seal with the same manifest and evidence root:

```sh
pnpm --filter @sema-evals/workflow-value corpus:seal -- \
  --manifest datasets/manifests/<manifest>.yaml \
  --root ../.. \
  --verify datasets/seals/<manifest>.json
```

The checked-in sacrificial manifest contains four independently reviewed tasks
and has a reproducible exploratory seal. Its locally materialized snapshots and
offline dependency caches remain untracked under `.cache/workflow-value/`.

The seal command executes each reviewed materialize/reset protocol in a fresh
temporary workspace. It materializes the pre-fix tree, changes the declared
probe file, runs reset, and requires the directory fingerprint to return exactly
to the sealed pre-fix digest. These commands are executable evidence and must be
reviewed before running the seal CLI.

An `exploratory` seal is not a confirmatory acquisition gate. A `confirmatory`
seal requires at least 30 held-out tasks and a family index covering train, dev,
and heldout assignments. Repository, subsystem, root-cause, validator, and
ancestry families may not cross those splits.
