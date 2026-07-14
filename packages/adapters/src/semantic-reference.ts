import { fingerprint } from "@sema-evals/core";

export interface SemanticReference {
  handle: string;
  display: string;
  full: string;
  digest: string;
  backend: string;
  officialSema: boolean;
}

export interface SemanticBackendMetadata {
  backend: string;
  semaVersion: string;
  canonicalizationVersion: string;
  officialSema: boolean;
}

export interface SemanticReferenceProvider {
  readonly backend: string;
  metadata(): Promise<SemanticBackendMetadata>;
  reference(
    handle: string,
    definition: Record<string, unknown>,
  ): Promise<SemanticReference>;
}

/**
 * Generates deterministic fixture references for scorer and harness tests.
 * It deliberately does not claim compatibility with Sema canonicalization.
 */
export class FixtureReferenceProvider implements SemanticReferenceProvider {
  public readonly backend = "fixture-sha256-stable-json-v1";

  public async metadata(): Promise<SemanticBackendMetadata> {
    return {
      backend: this.backend,
      semaVersion: "not-connected",
      canonicalizationVersion: "fixture-stable-json-v1",
      officialSema: false,
    };
  }

  public async reference(
    handle: string,
    definition: Record<string, unknown>,
  ): Promise<SemanticReference> {
    const digest = fingerprint(definition);
    return {
      handle,
      display: `${handle}#${digest.slice(0, 4)}`,
      full: `fixture:${handle}#sha256:${digest}`,
      digest,
      backend: this.backend,
      officialSema: false,
    };
  }
}

export function referencesMatch(
  expected: SemanticReference,
  observed: SemanticReference,
): boolean {
  return expected.full === observed.full;
}
