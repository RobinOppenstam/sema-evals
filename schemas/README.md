# Artifact schemas

These JSON Schemas are generated from the versioned Zod definitions in
`packages/core/src/schemas.ts`.

Regenerate after changing an artifact contract:

```bash
pnpm schemas:generate
```

Changing a persisted field or its meaning requires an artifact-schema version
bump and a migration note.
