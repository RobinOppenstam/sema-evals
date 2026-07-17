import type { DiscoveryPattern } from "./schemas.js";

export interface DependencyResolution {
  status: "complete" | "missing" | "cycle";
  orderedPatterns: DiscoveryPattern[];
  missingHandles: string[];
}

export function resolveDependencyClosure(
  rootHandle: string,
  catalog: readonly DiscoveryPattern[],
): DependencyResolution {
  const byHandle = new Map(catalog.map((pattern) => [pattern.handle, pattern]));
  const ordered: DiscoveryPattern[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const missing = new Set<string>();
  let cycle = false;

  const visit = (handle: string): void => {
    if (visited.has(handle) || missing.has(handle) || cycle) {
      return;
    }
    if (visiting.has(handle)) {
      cycle = true;
      return;
    }
    const pattern = byHandle.get(handle);
    if (!pattern) {
      missing.add(handle);
      return;
    }
    visiting.add(handle);
    for (const dependency of [...pattern.dependencies].sort()) {
      visit(dependency);
    }
    visiting.delete(handle);
    if (!cycle && missing.size === 0) {
      visited.add(handle);
      ordered.push(pattern);
    }
  };

  visit(rootHandle);
  return {
    status: cycle ? "cycle" : missing.size > 0 ? "missing" : "complete",
    orderedPatterns: cycle || missing.size > 0 ? [] : ordered,
    missingHandles: [...missing].sort(),
  };
}
