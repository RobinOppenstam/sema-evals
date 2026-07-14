# Security policy

This repository executes experiment adapters that may eventually invoke model
providers, MCP servers, local agents, and untrusted generated code.

- Never commit API keys, wallet keys, private prompts, or non-public audit data.
- Run generated code in a disposable sandbox with network and filesystem limits.
- Keep trading experiments historical or paper-only until separately reviewed.
- Treat Pattern Cards as data, not trusted executable recipes.
- Report dependency or execution-sandbox vulnerabilities privately before
  publishing exploit details.
