// The app's half of stable body ids: the engine assigns them (fundacad-core
// body_ids.rs) and the document keeps the `bodyIds` map it returns.
//
// A join's own record is preferred over the id it inherits from its target, so a file
// numbered before the map existed keeps the fresh id its join was given. The
// same rule would keep the id a feature had as a new body after it became a
// join, so an edit that makes a feature join, or join other targets, forgets
// that feature's records. The Rust twin is `join_went_stale` and
// `forget_feature`, held to the same answers by tests/vectors/join_edits.json.
import type { CadDocument, Feature } from "../types";

/** The join's targets as a comparable string, null when it does not join. */
export function joinSignature(f: Feature | undefined): string | null {
  const o = f as { operation?: unknown; targets?: unknown } | undefined;
  return o?.operation === "join" ? JSON.stringify(o.targets ?? null) : null;
}

export function joinWentStale(before: string | null | undefined, after: Feature): boolean {
  const now = joinSignature(after);
  return now !== null && before !== now;
}

/** Whether `key` is one the engine gave a body of `featureId`: `<id>:<n>`, `#` suffixed on a repeat. */
export function isFeatureKey(key: string, featureId: string): boolean {
  if (!key.startsWith(`${featureId}:`)) return false;
  return /^\d+#*$/.test(key.slice(featureId.length + 1));
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

/** Every feature's join signature, taken before an edit that may change it in place. */
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
