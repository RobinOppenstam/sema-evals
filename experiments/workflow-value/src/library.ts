import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fingerprint } from "@sema-evals/core";
import { z } from "zod";

const LIBRARY_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../library",
);

const patternSchema = z.object({
  handle: z.string().regex(/^[A-Z][A-Za-z0-9]+$/),
  title: z.string().min(1),
  purpose: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  guards: z.array(z.string().min(1)).min(1),
});

const librarySchema = z.object({
  schemaVersion: z.literal("workflow-library-v1"),
  libraryId: z.string().min(1),
  version: z.string().min(1),
  patterns: z.array(patternSchema).min(1),
});

const mappingSchema = z.object({
  schemaVersion: z.literal("workflow-library-mapping-v1"),
  mappingId: z.string().min(1),
  selectionRule: z.string().min(1),
  handles: z.array(z.string().min(1)).min(1),
});

const leakageAuditSchema = z.object({
  schemaVersion: z.literal("workflow-library-leakage-audit-v1"),
  status: z.literal("provisional-agent-review"),
  reviewScope: z.array(z.string().min(1)).min(1),
  assertions: z.record(z.literal(true)),
  reviewer: z.string().min(1),
  notes: z.array(z.string().min(1)),
});

const sourcesSchema = z.object({
  schemaVersion: z.literal("workflow-library-sources-v1"),
  status: z.literal("provisional"),
  createdAt: z.string().datetime(),
  sources: z
    .array(
      z.object({
        kind: z.string().min(1),
        locator: z.string().min(1),
        usedFor: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  heldoutDataUsed: z.literal(false),
  humanReview: z.object({
    status: z.literal("pending"),
    reviewer: z.null(),
    reviewedAt: z.null(),
  }),
});

export interface FrozenWorkflowLibrary {
  library: z.infer<typeof librarySchema>;
  mapping: z.infer<typeof mappingSchema>;
  leakageAudit: z.infer<typeof leakageAuditSchema>;
  sources: z.infer<typeof sourcesSchema>;
  resolvedContent: string;
  libraryRoot: string;
  mappingDigest: string;
  leakageAuditDigest: string;
  sourcesDigest: string;
}

function stableContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function loadFrozenWorkflowLibrary(): Promise<FrozenWorkflowLibrary> {
  const [libraryText, mappingText, leakageText, sourcesText] =
    await Promise.all([
      readFile(join(LIBRARY_DIRECTORY, "workflow-patterns.json"), "utf8"),
      readFile(join(LIBRARY_DIRECTORY, "mapping.json"), "utf8"),
      readFile(join(LIBRARY_DIRECTORY, "leakage-audit.json"), "utf8"),
      readFile(join(LIBRARY_DIRECTORY, "sources.json"), "utf8"),
    ]);
  const library = librarySchema.parse(JSON.parse(libraryText));
  const mapping = mappingSchema.parse(JSON.parse(mappingText));
  const leakageAudit = leakageAuditSchema.parse(JSON.parse(leakageText));
  const sources = sourcesSchema.parse(JSON.parse(sourcesText));
  const handles = new Set(library.patterns.map(({ handle }) => handle));
  for (const handle of mapping.handles) {
    if (!handles.has(handle)) {
      throw new Error(`Frozen mapping references missing pattern: ${handle}`);
    }
  }
  const selectedPatterns = mapping.handles.map(
    (handle) =>
      library.patterns.find((pattern) => pattern.handle === handle) ?? {
        handle,
        title: "",
        purpose: "",
        steps: [],
        guards: [],
      },
  );
  const resolvedContent = stableContent({
    schemaVersion: library.schemaVersion,
    libraryId: library.libraryId,
    version: library.version,
    patterns: selectedPatterns,
  });
  return {
    library,
    mapping,
    leakageAudit,
    sources,
    resolvedContent,
    libraryRoot: fingerprint(JSON.parse(resolvedContent)),
    mappingDigest: fingerprint(mapping),
    leakageAuditDigest: fingerprint(leakageAudit),
    sourcesDigest: fingerprint(sources),
  };
}

export function renderEqualProseContent(
  library: FrozenWorkflowLibrary,
): string {
  return library.resolvedContent;
}

export function renderResolvedReferenceContent(
  library: FrozenWorkflowLibrary,
): string {
  return library.resolvedContent;
}
