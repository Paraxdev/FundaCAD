// What guide mode reads from the window: where a target is, and the few facts a wait compares.

import * as THREE from "three";
import type { DocumentStore } from "../../document/store";
import type { Viewport } from "../../viewport/viewport";
import { SelectorError, edgePts, resolveEdge, resolveFace, type SelectorHost } from "../../viewport/modelSelectors";
import { resolveControl } from "./controls";
import type { GuideTarget, Resolution } from "./guideSession";
import type { Snapshot } from "./wait";

export interface ProbeHost {
  store: Pick<DocumentStore, "buildState" | "document">;
  viewport: Pick<Viewport, "faceTriangles" | "projectToScreen" | "getSelectedFaceIds" | "getSelectedBodies" | "selectedEdgeLines" | "domElement">;
  /** Fillet and Chamfer keep their picked edges as members, not as the selection. */
  tools?: { edgeFeature: { readonly active: boolean; memberRows(): { resolved: boolean }[] } };
}

/** World space lines to outline, each a polyline. */
export type ModelShape = { kind: "face" | "edge" | "body"; lines: THREE.Vector3[][]; name: string };

const EDGE_WORDS = /^(between\b|longest\b|shortest\b|edge\b)/;

function boundary(tris: THREE.Triangle[]): THREE.Vector3[][] {
  const key = (v: THREE.Vector3) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
  const seen = new Map<string, { a: THREE.Vector3; b: THREE.Vector3; n: number }>();
  for (const t of tris) {
    for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
      const ka = key(a), kb = key(b);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = seen.get(k);
      if (e) e.n++;
      else seen.set(k, { a, b, n: 1 });
    }
  }
  return [...seen.values()].filter((e) => e.n === 1).map((e) => [e.a, e.b]);
}

/** A model selector as the harness reads it: a face, or an edge for `between`,
 *  `longest`, `shortest` and `edge near=`, or a whole body. */
export function modelShape(h: SelectorHost & { store: ProbeHost["store"] }, sel: string): ModelShape {
  const text = sel.trim();
  const bodies = h.store.buildState.result?.bodies ?? [];
  const bodyId = text.replace(/^body:/, "");
  const body = bodies.find((b) => b.id === bodyId);
  if (body) {
    const edges = (h.store.buildState.result?.edges ?? []).filter((e) => e.body === body.id);
    return { kind: "body", name: body.id, lines: edges.map(edgePts) };
  }
  const words = text.replace(/^[\w-]+:/, "");
  if (EDGE_WORDS.test(words)) {
    const e = resolveEdge(h, text.replace(/(^|:)edge\s+/, "$1"));
    return { kind: "edge", name: `edge ${e.id}`, lines: [edgePts(e)] };
  }
  try {
    const f = resolveFace(h, text);
    return { kind: "face", name: `${f.body} face ${f.index}`, lines: boundary(f.tris) };
  } catch (err) {
    if (!(err instanceof SelectorError) || !/near=/.test(text)) throw err;
    const e = resolveEdge(h, text);
    return { kind: "edge", name: `edge ${e.id}`, lines: [edgePts(e)] };
  }
}

export function resolveTarget(h: ProbeHost, t: GuideTarget, doc: Document = document): Resolution {
  if (t.region) return { found: true };
  if (t.model !== undefined) {
    try {
      modelShape(h, t.model);
      return { found: true };
    } catch (err) {
      const near = err instanceof SelectorError ? err.candidates.slice(0, 5) : [];
      return { found: false, missing: err instanceof Error ? err.message : String(err), near };
    }
  }
  const r = resolveControl(t.ui ?? "", doc);
  if (r.el) return r.via ? { found: true, via: r.via } : { found: true };
  return { found: false, missing: r.missing, near: r.near };
}

const runningName = (doc: Document) => {
  const b = doc.querySelector<HTMLElement>('[data-action="running-tool"]');
  if (b) return (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s*\([^()]*\)\s*$/, "").trim() || null;
  return doc.querySelector<HTMLElement>("#toolrail")?.dataset.sketchTool ?? null;
};

function valueBox(doc: Document): Snapshot["value"] {
  const focused = doc.activeElement?.closest?.<HTMLElement>(".dim-field[data-field]");
  const field = focused ?? doc.querySelector<HTMLElement>(".dim-field.typed[data-field]");
  const input = field?.querySelector("input");
  return field && input ? { field: field.dataset.field ?? "", text: input.value.trim(), typed: field.classList.contains("typed") } : null;
}

export function takeSnapshot(h: ProbeHost, doc: Document = document): Snapshot {
  return {
    tool: runningName(doc),
    features: h.store.document.features.map((f) => ({ id: f.id, type: f.type })),
    selection: {
      faces: h.viewport.getSelectedFaceIds().length,
      edges: Math.max(
        h.viewport.selectedEdgeLines().length,
        h.tools?.edgeFeature.active ? h.tools.edgeFeature.memberRows().filter((r) => r.resolved).length : 0,
      ),
      bodies: h.viewport.getSelectedBodies().length,
    },
    value: valueBox(doc),
  };
}
