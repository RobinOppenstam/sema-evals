# Promoted report: hook-enforcement / 20260721T123000000Z-cursor-kimi

- Promoted on: 2026-07-21 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `/tmp/claude-1000/-home-jiberish-projects-opensource/bfb15a3b-bb11-4050-909d-d9b0919a0a33/scratchpad/bundles/20260721T123000000Z-cursor-kimi`
- Mode: exploratory
- Evidence claim: 144-trial babel relay through the same Cursor wrapper gate, model swapped to kimi-k2.7-code: warn detects 29/29 drifted relays but 6 ship anyway; enforce halts 28/28. Unaided (off) it catches just 6/28.

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
