import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  relayScenarioSetSchema,
  resultManifestSchema,
  trialRecordSchema,
} from "../packages/core/src/schemas.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "schemas");

const schemas = [
  ["relay-scenarios.schema.json", "RelayScenarioSet", relayScenarioSetSchema],
  ["result-manifest.schema.json", "ResultManifest", resultManifestSchema],
  ["trial-record.schema.json", "TrialRecord", trialRecordSchema],
] as const;

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  schemas.map(async ([file, name, schema]) => {
    const jsonSchema = zodToJsonSchema(schema, {
      name,
      target: "jsonSchema7",
      $refStrategy: "root",
    });
    await writeFile(
      join(outputDirectory, file),
      `${JSON.stringify(jsonSchema, null, 2)}\n`,
    );
  }),
);

console.log(`Generated ${schemas.length} schemas in ${outputDirectory}`);
