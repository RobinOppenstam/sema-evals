import {
  createModelProvider,
  type CreatedModelProvider,
  type ModelProviderConfig,
} from "@sema-evals/adapters";

import { assertDatasetReadyForModelPilot } from "./fixtures.js";
import type { WorkflowFixtureSet } from "./schemas.js";

export interface WorkflowModelProviderConfig extends ModelProviderConfig {
  fixtureSet: WorkflowFixtureSet;
}

/**
 * Future model pilots must use the shared provider factory, but seed fixtures
 * fail closed before any provider adapter can be constructed or invoked.
 */
export function createWorkflowModelProvider(
  config: WorkflowModelProviderConfig,
): CreatedModelProvider {
  assertDatasetReadyForModelPilot(config.fixtureSet);
  return createModelProvider({
    provider: config.provider,
    systemPrompt: config.systemPrompt,
    model: config.model,
    maxTokens: config.maxTokens,
    thinking: config.thinking,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
    ...(config.harnessBin === undefined
      ? {}
      : { harnessBin: config.harnessBin }),
    ...(config.harnessWorkingDirectory === undefined
      ? {}
      : { harnessWorkingDirectory: config.harnessWorkingDirectory }),
  });
}
