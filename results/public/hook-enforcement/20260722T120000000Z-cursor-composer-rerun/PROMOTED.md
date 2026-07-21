# Promoted report: hook-enforcement / 20260722T120000000Z-cursor-composer-rerun

- Promoted on: 2026-07-22 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `/tmp/claude-1000/-home-jiberish-projects-opensource/bfb15a3b-bb11-4050-909d-d9b0919a0a33/scratchpad/bundles/20260722T120000000Z-cursor-composer-rerun`
- Mode: exploratory
- Evidence claim: 144-trial babel relay replicating the 2026-07-20 composer-2.5-fast run through the same Cursor wrapper gate: warn detects 31/31 drifted relays but 18 ship anyway (58%, vs 78% original); enforce halts 31/31. Composer remains the leakiest model in the isolation set.

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
