import {
  SEMA_DISCOVERY_CONDITIONS,
  type SemaDiscoveryCondition,
} from "./schemas.js";

export interface DiscoveryConditionPolicy {
  receivesPatterns: boolean;
  preselected: boolean;
  addressed: boolean;
  performsDiscovery: boolean;
  reusesWithinSession: boolean;
}

const POLICIES: Record<SemaDiscoveryCondition, DiscoveryConditionPolicy> = {
  "task-only": {
    receivesPatterns: false,
    preselected: false,
    addressed: false,
    performsDiscovery: false,
    reusesWithinSession: false,
  },
  "preselected-prose": {
    receivesPatterns: true,
    preselected: true,
    addressed: false,
    performsDiscovery: false,
    reusesWithinSession: false,
  },
  "preselected-addressed": {
    receivesPatterns: true,
    preselected: true,
    addressed: true,
    performsDiscovery: false,
    reusesWithinSession: false,
  },
  discovery: {
    receivesPatterns: true,
    preselected: false,
    addressed: true,
    performsDiscovery: true,
    reusesWithinSession: false,
  },
  "discovery-reuse": {
    receivesPatterns: true,
    preselected: false,
    addressed: true,
    performsDiscovery: true,
    reusesWithinSession: true,
  },
};

export function buildConditions(): SemaDiscoveryCondition[] {
  return [...SEMA_DISCOVERY_CONDITIONS];
}

export function conditionPolicy(
  condition: SemaDiscoveryCondition,
): DiscoveryConditionPolicy {
  return POLICIES[condition];
}
