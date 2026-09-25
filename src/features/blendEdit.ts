// What re-editing a committed fillet or chamfer writes back.
//
// The edge tool rebuilds its feature from its own state for the live preview,
// and that object only knows what the tool manages: no name, no fields another
// panel set, and selectors re-derived from the ghosts. Committing it as is
// renamed the feature and could rewrite its edges. So the commit starts from the
// feature as it was and takes from the tool only what actually changed while it
// was open.

import type { Feature, Selector } from "../types";

/** Every field the edge tool reads or writes on a fillet or chamfer. */
const MANAGED = [
  "type", "radius", "distance", "distance2", "chamferType", "sizeType", "tangentEdges", "profile", "continuity",
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const asList = (edges: unknown): Selector[] =>
  edges === undefined ? [] : Array.isArray(edges) ? (edges as Selector[]) : [edges as Selector];

/** True when both hold the same selectors, in any order. */
export function sameMembers(a: unknown, b: unknown): boolean {
  const key = (xs: Selector[]) => xs.map((x) => JSON.stringify(x)).sort();
  return same(key(asList(a)), key(asList(b)));
}

export interface BlendEdit {
  /** the committed feature, before the edit */
  original: Feature;
  /** what the tool built from its state the moment it opened, before any input */
  opened: Feature;
  /** what the tool builds from its state now */
  built: Feature;
  /** the parameter the size field is a bare reference to, see store.bareParamRef */
  paramRef: string | null;
}

export interface BlendEditCommit {
  /** the replacement feature, null when nothing but a bound size changed */
  feature: Feature | null;
  /** the parameter to set, null when the size is not bound or did not move */
  param: { name: string; value: number } | null;
  /** why nothing is written, when the edit cannot be committed as asked */
  refused?: string;
}

const sizeField = (f: Feature) => (f.type === "chamfer" ? "distance" : "radius");

/** The original feature with each tool-managed field that moved since the tool
 *  opened taken from `built`, and every other field (name, id, anything the tool
 *  does not know) left exactly as it was. Edges are only replaced when the
 *  member set itself changed, never re-derived just because the tool saw them. */
export function editedBlend(original: Feature, opened: Feature, built: Feature): Feature {
  const out = { ...original } as Record<string, unknown>;
  const o = opened as unknown as Record<string, unknown>;
  const b = built as unknown as Record<string, unknown>;
  for (const k of MANAGED) {
    if (same(o[k], b[k])) continue;
    if (b[k] === undefined) delete out[k];
    else out[k] = b[k];
  }
  if (!sameMembers(o.edges, b.edges)) out.edges = b.edges;
  return out as unknown as Feature;
}

/** Split an edit into the feature write and the parameter write. A size bound
 *  to a parameter is written to the parameter only, and the field keeps its
 *  binding; a plain size is part of the feature. */
export function blendEditCommit(e: BlendEdit): BlendEditCommit {
  if (!e.paramRef) {
    const feature = editedBlend(e.original, e.opened, e.built);
    return { feature: same(feature, e.original) ? null : feature, param: null };
  }
  // The parameter is bound to the saved treatment's size field. A flip would
  // write a distance into a radius parameter and leave the new field unset.
  if (e.built.type !== e.opened.type) {
    return {
      feature: null,
      param: null,
      refused: `The ${sizeField(e.opened)} is driven by parameter "${e.paramRef}", so it cannot become a ${e.built.type} here`,
    };
  }
  const field = sizeField(e.built);
  const openedSize = (e.opened as unknown as Record<string, unknown>)[field];
  const value = (e.built as unknown as Record<string, unknown>)[field];
  const sizeless = { ...e.built, [field]: openedSize } as Feature;
  const feature = editedBlend(e.original, e.opened, sizeless);
  const moved = typeof value === "number" && !same(value, openedSize);
  return {
    feature: same(feature, e.original) ? null : feature,
    param: moved ? { name: e.paramRef, value: value as number } : null,
  };
}
