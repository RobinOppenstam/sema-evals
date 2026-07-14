import type { ExperimentCondition } from "@sema-evals/core";

export interface ConditionPolicy {
  transport:
    | "task-only"
    | "inline-definition"
    | "opaque-reference"
    | "content-reference";
  hydratesDefinition: boolean;
  verifiesReference: boolean;
  enforcesMismatch: boolean;
}

export const CONDITION_POLICIES: Record<ExperimentCondition, ConditionPolicy> =
  {
    baseline: {
      transport: "task-only",
      hydratesDefinition: false,
      verifiesReference: false,
      enforcesMismatch: false,
    },
    "equal-prose": {
      transport: "inline-definition",
      hydratesDefinition: false,
      verifiesReference: false,
      enforcesMismatch: false,
    },
    "opaque-resolver": {
      transport: "opaque-reference",
      hydratesDefinition: true,
      verifiesReference: false,
      enforcesMismatch: false,
    },
    "addressed-voluntary": {
      transport: "content-reference",
      hydratesDefinition: true,
      verifiesReference: true,
      enforcesMismatch: false,
    },
    "addressed-enforced": {
      transport: "content-reference",
      hydratesDefinition: true,
      verifiesReference: true,
      enforcesMismatch: true,
    },
  };
