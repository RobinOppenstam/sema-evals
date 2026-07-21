# Promoted report: hook-enforcement / 20260721T120000000Z-cursor-nano

- Promoted on: 2026-07-21 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `/tmp/claude-1000/-home-jiberish-projects-opensource/bfb15a3b-bb11-4050-909d-d9b0919a0a33/scratchpad/bundles/20260721T120000000Z-cursor-nano`
- Mode: exploratory
- Evidence claim: 144-trial babel relay through the same Cursor wrapper gate, model swapped to gpt-5.4-nano-low: warn detects 24/24 drifted relays but 10 ship anyway; enforce halts 25/25. Heavy caveat: 47 hop failures and 20 malformed audits thin the denominators.

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
