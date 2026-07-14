# ADR 0009: A static public report site generated from promoted artifacts

- Status: accepted
- Date: 2026-07-14

## Context

Result bundles are generated under `results/` and, per the repository
instructions and ADR conventions, remain untracked "unless intentionally
promoted into a dated public report." Until now that promotion path did not
exist: there was no mechanism to publish a run, no policy for what a published
artifact may contain, and no way to view a run without cloning the repository and
reading JSONL by hand.

Publishing research results carries obligations the experiment standard makes
explicit. Reporting must distinguish deterministic harness validation from an
exploratory model pilot from a preregistered confirmatory experiment; it must
report counts as well as rates; and it must never hide malformed or negative
outcomes. A public surface that blurred those lines — for example, one that let a
model pilot read as confirmatory evidence — would violate the project's core
non-negotiable rule against overclaiming.

Raw run bundles also contain full provider transcripts, including a per-entry
`raw` field carrying the unmodified provider payload. Those payloads can hold
provider-internal fields we do not want to commit to version control in
perpetuity.

## Decision

### Promotion is a deliberate, validated act

A run is published only by running `pnpm report:promote -- <bundle-dir>`, which
copies the bundle into tracked `results/public/<experimentId>/<runId>/`. The
`.gitignore` allowlists exactly that subtree; everything else under `results/`
stays ignored. Promotion validates the manifest against `resultManifestSchema`
before writing anything and refuses to overwrite an existing promoted run without
`--force`. Nothing is published as a side effect of running an experiment.

### Published trials are a redacted public derivative

`manifest.json` and `summary.json` are copied verbatim. The trials are written as
`trials.public.jsonl`: every trial record is preserved except that each
transcript entry's `raw` payload is replaced with `null` and each content block's
`text` is capped at 20,000 characters with a truncation marker. The derivative is
re-validated against `trialRecordSchema`, so a malformed redaction fails loudly
rather than being committed. Full raw bundles are retained locally only. A
`PROMOTED.md` records the source directory and the exact redaction rules, so the
policy travels with the data. This is the "redacted public derivative" the
experiment standard permits.

### The site is static, self-contained, and computed from artifacts

`pnpm site:build` reads every promoted run and emits plain HTML with inline CSS
and inline SVG charts under `site/dist/` (gitignored). There is no frontend
framework and no runtime dependency; a small amount of vanilla JavaScript sorts
one table. The output is theme-aware via `prefers-color-scheme`. A static site
has no server to trust or maintain, and the artifacts are the single source of
truth.

Every rate and count on the site is **recomputed from `trials.public.jsonl` at
build time**. The committed `summary.json` is cross-checked against the
recomputation and any disagreement is printed as a build warning rather than
silently trusted — the same fail-loud, self-checking discipline the rest of the
repository applies to digests and schemas. Counts are shown alongside rates
because the standard requires counts.

### Mode labelling is structural, not editorial

Each run carries a color-coded mode badge derived from the manifest's `mode`
field, and a run page renders a prominent banner containing the manifest's
`evidenceClaim` verbatim. For a model pilot that claim is "Exploratory model
pilot. Not preregistered, not confirmatory evidence." Because the label is read
from the manifest rather than hardcoded as prose, an exploratory run cannot be
relabelled as confirmatory by editing the site generator.

### Deployment is standard GitHub Pages, enabled by an operator

`.github/workflows/pages.yml` builds the site on push to `main` and deploys
`site/dist` with `actions/upload-pages-artifact` and `actions/deploy-pages` under
`pages`/`id-token` permissions. The workflow never enables Pages via API; an
operator flips the repository setting once.

### Determinism

Generated HTML contains no wall-clock timestamps. Dates shown come from each
promoted manifest's `createdAt`, so rebuilding the site from the same artifacts
produces byte-identical output.

## Consequences

- Publishing a result is now a single reproducible command pair
  (`report:promote`, `site:build`) with a documented, schema-validated
  derivative policy.
- The public surface cannot silently overstate evidence: mode and evidence claim
  come from the manifest, and every statistic is recomputed from the trials.
- Raw provider payloads never enter version control; the local bundle remains the
  lossless record.
- Promotion and derivative logic live in `scripts/lib/` with unit tests, so the
  redaction rules and aggregate computation are verified independently of a live
  run.
