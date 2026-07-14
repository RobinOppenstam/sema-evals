import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SemaPythonBridgeError,
  type SemaHandshakeResult,
  type SemaPythonRegistryClient,
  type SemaRegistryPatternIdentity,
  type SemaRegistryPatternInput,
} from "@sema-evals/adapters";
import { fingerprint, type RelayScenario } from "@sema-evals/core";

import type {
  RelayHydrationResult,
  RelayHandshakeResult,
  RelaySemanticRuntime,
} from "./relay.js";

interface PreparedPatternState {
  definition: Record<string, unknown>;
  identity: SemaRegistryPatternIdentity;
  handshake: SemaHandshakeResult;
  vocabularyRoot: string;
}

interface PreparedScenarioState {
  canonical: PreparedPatternState;
  drifted: PreparedPatternState;
}

const COMPUTED_PATTERN_FIELDS = new Set([
  "handle",
  "sema_id",
  "sema_ref",
  "sema_stub",
  "sema_layer",
  "sema_category",
]);

function fixturePattern(
  handle: string,
  definition: Record<string, unknown>,
): SemaRegistryPatternInput {
  return { ...definition, handle };
}

function definitionFromResolved(
  pattern: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(pattern).filter(
      ([field]) => !COMPUTED_PATTERN_FIELDS.has(field),
    ),
  );
}

function identityByHandle(
  identities: readonly SemaRegistryPatternIdentity[],
): Map<string, SemaRegistryPatternIdentity> {
  return new Map(identities.map((identity) => [identity.handle, identity]));
}

function requiredIdentity(
  identities: ReadonlyMap<string, SemaRegistryPatternIdentity>,
  handle: string,
): SemaRegistryPatternIdentity {
  const identity = identities.get(handle);
  if (!identity) {
    throw new SemaPythonBridgeError(
      `Prepared registry did not contain ${handle}.`,
    );
  }
  return identity;
}

async function inspectState(options: {
  client: SemaPythonRegistryClient;
  dbPath: string;
  handle: string;
  expectedDefinition: Record<string, unknown>;
  expectedDigest: string;
  identity: SemaRegistryPatternIdentity;
  vocabularyRoot: string;
}): Promise<PreparedPatternState> {
  const resolved = await options.client.resolve(
    options.dbPath,
    options.handle,
    0,
  );
  const rawPattern = resolved.patterns[options.handle];
  if (!rawPattern) {
    throw new SemaPythonBridgeError(
      `Sema did not resolve ${options.handle} from ${options.dbPath}.`,
    );
  }
  const definition = definitionFromResolved(rawPattern);
  if (fingerprint(definition) !== fingerprint(options.expectedDefinition)) {
    throw new SemaPythonBridgeError(
      `Registry hydration changed the fixture definition for ${options.handle}.`,
    );
  }
  const handshake = await options.client.handshake(
    options.dbPath,
    options.handle,
    options.expectedDigest,
  );
  return {
    definition,
    identity: options.identity,
    handshake,
    vocabularyRoot: options.vocabularyRoot,
  };
}

class PreparedSemaRegistryRuntime implements RelaySemanticRuntime {
  public readonly backend: string;
  public readonly canonicalVocabularyRoot: string;
  private readonly states: ReadonlyMap<string, PreparedScenarioState>;
  private readonly temporaryDirectory: string;

  public constructor(options: {
    backend: string;
    canonicalVocabularyRoot: string;
    states: ReadonlyMap<string, PreparedScenarioState>;
    temporaryDirectory: string;
  }) {
    this.backend = options.backend;
    this.canonicalVocabularyRoot = options.canonicalVocabularyRoot;
    this.states = options.states;
    this.temporaryDirectory = options.temporaryDirectory;
  }

  public async hydrate(
    scenarioId: string,
    handle: string,
    drifted: boolean,
  ): Promise<RelayHydrationResult> {
    const state = this.state(scenarioId, handle, drifted);
    return {
      definition: state.definition,
      observedReference: state.identity.full,
      workspaceRoot: state.vocabularyRoot,
      resolver: this.backend,
    };
  }

  public async handshake(
    scenarioId: string,
    handle: string,
    expectedDigest: string,
    drifted: boolean,
  ): Promise<RelayHandshakeResult> {
    const scenario = this.states.get(scenarioId);
    if (!scenario) {
      throw new SemaPythonBridgeError(
        `No prepared registry state exists for ${scenarioId}.`,
      );
    }
    if (scenario.canonical.identity.digest !== expectedDigest) {
      throw new SemaPythonBridgeError(
        `Reference provider and canonical registry disagree for ${handle}.`,
      );
    }
    const state = this.state(scenarioId, handle, drifted);
    return {
      verdict: state.handshake.verdict,
      observedReference: state.identity.full,
      workspaceRoot: state.vocabularyRoot,
      ...(state.handshake.reason ? { reason: state.handshake.reason } : {}),
      details: state.handshake.details,
    };
  }

  public async cleanup(): Promise<void> {
    await rm(this.temporaryDirectory, { recursive: true, force: true });
  }

  private state(
    scenarioId: string,
    handle: string,
    drifted: boolean,
  ): PreparedPatternState {
    const scenario = this.states.get(scenarioId);
    if (!scenario) {
      throw new SemaPythonBridgeError(
        `No prepared registry state exists for ${scenarioId}.`,
      );
    }
    const state = drifted ? scenario.drifted : scenario.canonical;
    if (state.identity.handle !== handle) {
      throw new SemaPythonBridgeError(
        `Prepared registry handle mismatch: expected ${handle}, received ${state.identity.handle}.`,
      );
    }
    return state;
  }
}

export async function prepareSemaRegistryRuntime(
  scenarios: readonly RelayScenario[],
  client: SemaPythonRegistryClient,
): Promise<RelaySemanticRuntime> {
  const handles = new Set<string>();
  for (const scenario of scenarios) {
    if (handles.has(scenario.contract.handle)) {
      throw new SemaPythonBridgeError(
        `Babel Relay registry handles must be unique: ${scenario.contract.handle}.`,
      );
    }
    handles.add(scenario.contract.handle);
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sema-evals-babel-"));
  try {
    const canonicalPath = join(temporaryDirectory, "canonical.db");
    const canonicalBuild = await client.buildRegistry({
      dbPath: canonicalPath,
      workspaceId: "babel-canonical",
      label: "Babel Relay canonical vocabulary",
      patterns: scenarios.map((scenario) =>
        fixturePattern(
          scenario.contract.handle,
          scenario.contract.canonicalDefinition,
        ),
      ),
    });
    const canonicalIdentities = identityByHandle(canonicalBuild.patterns);
    const canonicalStates = new Map<string, PreparedPatternState>();

    for (const scenario of scenarios) {
      const identity = requiredIdentity(
        canonicalIdentities,
        scenario.contract.handle,
      );
      const state = await inspectState({
        client,
        dbPath: canonicalPath,
        handle: scenario.contract.handle,
        expectedDefinition: scenario.contract.canonicalDefinition,
        expectedDigest: identity.digest,
        identity,
        vocabularyRoot: canonicalBuild.workspace.vocabularyRoot,
      });
      if (state.handshake.verdict !== "PROCEED") {
        throw new SemaPythonBridgeError(
          `Canonical registry handshake did not proceed for ${scenario.contract.handle}.`,
        );
      }
      canonicalStates.set(scenario.id, state);
    }

    const states = new Map<string, PreparedScenarioState>();
    for (const scenario of scenarios) {
      const canonical = canonicalStates.get(scenario.id);
      if (!canonical) {
        throw new SemaPythonBridgeError(
          `Canonical state is missing for ${scenario.id}.`,
        );
      }
      if (scenario.mutation === null) {
        states.set(scenario.id, { canonical, drifted: canonical });
        continue;
      }

      const driftedPath = join(temporaryDirectory, `${scenario.id}.db`);
      const driftedBuild = await client.buildRegistry({
        dbPath: driftedPath,
        workspaceId: `babel-drifted-${scenario.id}`,
        label: `Babel Relay drifted vocabulary: ${scenario.id}`,
        patterns: scenarios.map((candidate) =>
          fixturePattern(
            candidate.contract.handle,
            candidate.id === scenario.id
              ? candidate.contract.mutatedDefinition
              : candidate.contract.canonicalDefinition,
          ),
        ),
      });
      if (
        driftedBuild.workspace.vocabularyRoot ===
        canonicalBuild.workspace.vocabularyRoot
      ) {
        throw new SemaPythonBridgeError(
          `Drifted registry root did not change for ${scenario.id}.`,
        );
      }
      const driftedIdentities = identityByHandle(driftedBuild.patterns);
      const driftedIdentity = requiredIdentity(
        driftedIdentities,
        scenario.contract.handle,
      );
      for (const candidate of scenarios) {
        const canonicalIdentity = requiredIdentity(
          canonicalIdentities,
          candidate.contract.handle,
        );
        const candidateDriftedIdentity = requiredIdentity(
          driftedIdentities,
          candidate.contract.handle,
        );
        const shouldDiffer = candidate.id === scenario.id;
        if (
          (canonicalIdentity.digest !== candidateDriftedIdentity.digest) !==
          shouldDiffer
        ) {
          throw new SemaPythonBridgeError(
            `Registry variant ${scenario.id} did not isolate its mutation to ${scenario.contract.handle}.`,
          );
        }
      }
      const drifted = await inspectState({
        client,
        dbPath: driftedPath,
        handle: scenario.contract.handle,
        expectedDefinition: scenario.contract.mutatedDefinition,
        expectedDigest: canonical.identity.digest,
        identity: driftedIdentity,
        vocabularyRoot: driftedBuild.workspace.vocabularyRoot,
      });
      if (drifted.handshake.verdict !== "HALT") {
        throw new SemaPythonBridgeError(
          `Drifted registry handshake did not halt for ${scenario.contract.handle}.`,
        );
      }
      states.set(scenario.id, { canonical, drifted });
    }

    return new PreparedSemaRegistryRuntime({
      backend: client.backend,
      canonicalVocabularyRoot: canonicalBuild.workspace.vocabularyRoot,
      states,
      temporaryDirectory,
    });
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}
