import {
  WORKFLOW_VALUE_CONDITIONS,
  type WorkflowValueCondition,
} from "./schemas.js";

export interface WorkflowConditionPolicy {
  condition: WorkflowValueCondition;
  deliversWorkflow: boolean;
  wireStyle:
    "task-only" | "inline-prose" | "opaque-reference" | "content-reference";
  hydratesWorkflow: boolean;
  contentAddressed: boolean;
  explicitMismatchNotice: boolean;
}

const POLICIES: Record<WorkflowValueCondition, WorkflowConditionPolicy> = {
  "task-only": {
    condition: "task-only",
    deliversWorkflow: false,
    wireStyle: "task-only",
    hydratesWorkflow: false,
    contentAddressed: false,
    explicitMismatchNotice: false,
  },
  "equal-prose": {
    condition: "equal-prose",
    deliversWorkflow: true,
    wireStyle: "inline-prose",
    hydratesWorkflow: false,
    contentAddressed: false,
    explicitMismatchNotice: false,
  },
  "opaque-resolver": {
    condition: "opaque-resolver",
    deliversWorkflow: true,
    wireStyle: "opaque-reference",
    hydratesWorkflow: true,
    contentAddressed: false,
    explicitMismatchNotice: false,
  },
  "content-addressed": {
    condition: "content-addressed",
    deliversWorkflow: true,
    wireStyle: "content-reference",
    hydratesWorkflow: true,
    contentAddressed: true,
    explicitMismatchNotice: false,
  },
  "content-addressed-repair": {
    condition: "content-addressed-repair",
    deliversWorkflow: true,
    wireStyle: "content-reference",
    hydratesWorkflow: true,
    contentAddressed: true,
    explicitMismatchNotice: true,
  },
};

export function buildConditions(): WorkflowValueCondition[] {
  return [...WORKFLOW_VALUE_CONDITIONS];
}

export function conditionPolicy(
  condition: WorkflowValueCondition,
): WorkflowConditionPolicy {
  return POLICIES[condition];
}
