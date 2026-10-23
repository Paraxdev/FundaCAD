// Re-editing a committed fillet or chamfer. The tool's preview feature lacks the name, other panels' fields and the
// original selectors, so the commit starts from the original and takes only what changed while the tool was open.

import type { Feature, Selector } from "../types";

/** Fields the edge tool reads or writes on a fillet or chamfer. */
const MANAGED = [
  "type",
  "radius",
  "distance",
  "distance2",
  "chamferType",
  "sizeType",
  "tangentEdges",
  "profile",
  "continuity",
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const asList = (edges: unknown): Selector[] =>
  edges === undefined ? [] : Array.isArray(edges) ? (edges as Selector[]) : [edges as Selector];

/** Order insensitive. */
export function sameMembers(a: unknown, b: unknown): boolean {
  const key = (xs: Selector[]) => xs.map((x) => JSON.stringify(x)).sort();
  return same(key(asList(a)), key(asList(b)));
}

export interface BlendEdit {
  original: Feature;
  /** built from the tool state when it opened, before any input */
  opened: Feature;
  built: Feature;
  /** the parameter the size field is a bare reference to, see store.bareParamRef */
  paramRef: string | null;
}

export interface BlendEditCommit {
  /** null when nothing but a bound size changed */
  feature: Feature | null;
  /** null when the size is not bound or did not move */
  param: { name: string; value: number } | null;
  /** why nothing is written, when the edit cannot be committed as asked */
  refused?: string;
}

const sizeField = (f: Feature) => (f.type === "chamfer" ? "distance" : "radius");

/** Fields the tool does not manage stay exactly as they were. Edges are replaced only when the member set itself
 *  changed, never re-derived just because the tool saw them. */
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

/** A size bound to a parameter is written to the parameter only and the field keeps its binding; a plain size
 *  goes in the feature. */
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
