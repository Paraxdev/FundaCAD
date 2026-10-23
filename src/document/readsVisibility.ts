import { isCoreFeatureType, type Feature } from "../types";

// Same rule as the engine cache key (fundacad-geom cache/keys.rs reads_visibility). Plugins pick their own targets.
export function readsBodyVisibility(f: Feature): boolean {
  const { targets, hiddenBodies, operation } = f as {
    targets?: unknown;
    hiddenBodies?: unknown;
    operation?: unknown;
  };
  if (!isCoreFeatureType(f.type)) return true;
  if (Array.isArray(targets) && targets.length) return false;
  if (f.type === "extrude") return hiddenBodies == null;
  return f.type === "press-pull" || (typeof operation === "string" && operation !== "new");
}
