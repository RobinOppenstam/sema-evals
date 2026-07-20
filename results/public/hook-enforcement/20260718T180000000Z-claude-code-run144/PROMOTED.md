# Promoted report: hook-enforcement / 20260718T180000000Z-claude-code-run144

- Promoted on: 2026-07-18 (run creation date; promotion is deterministic and clock-free)
- Source bundle: `/tmp/claude-1000/-home-jiberish-projects-opensource/bfb15a3b-bb11-4050-909d-d9b0919a0a33/scratchpad/bundles/babel-hook-run144`
- Mode: exploratory
- Evidence claim: 144-trial multi-hop babel relay through Claude Code with the ref-gate hook (haiku): warn detects 32/32 but 4 drifted relays ship anyway; enforce halts 32/32 pre-model.

## Public derivative rules

- Each transcript entry's `raw` field is replaced with `null`. Raw provider payloads can carry provider-internal fields we do not want to commit to forever; the experiment standard permits a redacted public derivative.
- Each transcript content block's `text` is capped at 20,000 characters. Truncated text is marked with a `[truncated N chars]` suffix.
- `manifest.json` and `summary.json` are copied verbatim. Full raw trial bundles are retained locally and are never committed.
