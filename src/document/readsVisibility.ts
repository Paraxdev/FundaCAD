import { isCoreFeatureType, type Feature } from "../types";

/** Whether a feature's result depends on which bodies are shown, the same rule
 *  as the engine's cache key (crates/fundacad-geom/src/cache/keys.rs,
 *  reads_visibility). A plugin picks its own targets, so its features always do. */
export function readsBodyVisibility(f: Feature): boolean {
  const { targets, hiddenBodies, operation } = f as {
    targets?: unknown; hiddenBodies?: unknown; operation?: unknown;
  };
  if (!isCoreFeatureType(f.type)) return true;
  if (Array.isArray(targets) && targets.length) return false;
  if (f.type === "extrude") return hiddenBodies == null;
  return f.type === "press-pull" || (typeof operation === "string" && operation !== "new");
}
