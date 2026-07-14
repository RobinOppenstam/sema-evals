import { createHash } from "node:crypto";

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForFingerprint);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeForFingerprint(entry)]),
    );
  }

  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForFingerprint(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprint(value: unknown): string {
  return sha256Text(stableJson(value));
}

export function utf8Bytes(value: unknown): number {
  const serialized = typeof value === "string" ? value : stableJson(value);
  return Buffer.byteLength(serialized, "utf8");
}
