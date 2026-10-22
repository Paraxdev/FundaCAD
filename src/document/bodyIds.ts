// The engine assigns body ids (fundacad-core body_ids.rs), the document keeps the `bodyIds` map. A join's own record
// beats the id it inherits, so making a feature join forgets its records. Rust twin: `join_went_stale`, `forget_feature`.
import type { CadDocument, Feature } from "../types";

export function joinSignature(f: Feature | undefined): string | null {
  const o = f as { operation?: unknown; targets?: unknown } | undefined;
  return o?.operation === "join" ? JSON.stringify(o.targets ?? null) : null;
}

export function joinWentStale(before: string | null | undefined, after: Feature): boolean {
  const now = joinSignature(after);
  return now !== null && before !== now;
}

// Engine keys are `<id>:<n>`, `#` suffixed on a repeat.
export function isFeatureKey(key: string, featureId: string): boolean {
  if (!key.startsWith(`${featureId}:`)) return false;
  return /^\d+#*$/.test(key.slice(featureId.length + 1));
}

// A document handed over whole gets an empty map, or it would be numbered like a pre-map file where a join took a
// fresh id. Rust twin `ensure_map`, held to tests/vectors/handed_over.json.
export function ensureBodyIds(doc: { bodyIds?: unknown }): boolean {
  const m = doc.bodyIds;
  if (m && typeof m === "object" && !Array.isArray(m)) return false;
  doc.bodyIds = {};
  return true;
}

export function forgetFeature(map: Record<string, string>, featureId: string): boolean {
  let gone = false;
  for (const key of Object.keys(map)) {
    if (isFeatureKey(key, featureId)) {
      delete map[key];
      gone = true;
    }
  }
  return gone;
}

// Taken before an edit that may change the signatures in place.
export function joinSignatures(doc: CadDocument): Map<string, string | null> {
  return new Map(doc.features.map((f) => [f.id, joinSignature(f)]));
}

export function forgetStaleJoins(before: Map<string, string | null>, doc: CadDocument): void {
  const map = doc.bodyIds;
  if (!map) return;
  for (const f of doc.features) {
    if (joinWentStale(before.get(f.id), f)) forgetFeature(map, f.id);
  }
}
