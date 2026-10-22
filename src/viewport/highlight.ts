// Highlighting without post-processing: an edge recolours its span of its body's instance colour buffer, a face its own
// vertex colour range (per-face tessellation keeps each face's vertices distinct).

import * as THREE from "three";
import { pushAll } from "../lib/pushAll";
import { bodyOfFace, edgeObjects, type BodyMesh, type ModelView } from "./render";
import type { EdgeRef } from "./edgeLines";
import {
  disposeFaceHoverOverlay,
  makeFaceHoverOverlay,
  makeSelectionGlow,
  removeSelectionGlows,
  type GlowKind,
} from "./selectionGlow";

const EDGE_BASE = new THREE.Color(0x1b1f24);
const HOVER = new THREE.Color(0xffd089); // pale hot amber (under cursor)
/** Shared with edgeEmphasis.ts so the emphasis line matches the tint it reinforces. */
export const EDGE_HOVER_COLOR = HOVER.getHex();
// Selected, the Forge accent, distinct from the paler hover.
const SELECT = new THREE.Color(0xff7a3c);
// The edge a fillet or chamfer failed on. Highest precedence, or the signal vanishes once the user mouses over it.
const ERROR = new THREE.Color(0xe23b3b);

/** Recolor one edge through the merged object that draws it. */
function paint(e: EdgeRef, color: THREE.Color) {
  e.draw.setColor(e.slot, color);
}

/** Back to idle, which for a faint tangent edge is lighter than `base`. */
function paintIdle(e: EdgeRef, base: THREE.Color) {
  e.draw.setIdleColor(e.slot, base);
}

export interface HoverState {
  body: string | null;
  edge: EdgeRef | null;
  faces: readonly number[];
}

export function sameHover(a: HoverState | undefined, b: HoverState | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.body === b.body &&
    a.edge === b.edge &&
    a.faces.length === b.faces.length &&
    a.faces.every((f, i) => f === b.faces[i])
  );
}

export class Highlighter {
  private hoveredEdge: EdgeRef | null = null;
  /** More than one when the face under the cursor is a piece of a split run (faceBands), so the hover shows what the
   *  click will take. */
  private hoveredFaces: readonly number[] = [];
  private hoveredBody: string | null = null;
  private selectedEdges = new Set<EdgeRef>();
  private selectedFaces = new Set<number>();
  /** The bodies of the selected and hovered faces, null once either changed. */
  private faceBodies: Set<string> | null = null;
  private selectedBodies = new Set<string>();
  private errorEdges = new Set<EdgeRef>();
  // idle (un-hovered, un-selected) edge color. Raised to a visible "selectable"
  // tint while the fillet/chamfer edge tool is active so you can SEE every edge.
  private edgeBase = EDGE_BASE.clone();

  constructor(private view: ModelView) {
    for (const b of view.bodies) removeSelectionGlows(b.mesh);
  }

  /** Built once: a linear find per painted body scans thousands on an import. No invalidation needed, setModel() builds a
   *  fresh ModelView and Highlighter together. */
  private byId: Map<string, BodyMesh> | null = null;

  /** Selection and hover overlay per body (selectionGlow.ts), parented to its mesh so it follows a move ghost drag and
   *  goes with the model. */
  private bodyGlows = new Map<string, THREE.Mesh>();
  /** Kept by key once taken down, since every pointer move clears the hover and sets it again. */
  private hoverOverlay: { key: string; meshes: THREE.Mesh[]; shown: boolean } | null = null;

  private bodyById(bodyId: string): BodyMesh | undefined {
    if (!this.byId) {
      this.byId = new Map();
      for (const b of this.view.bodies) this.byId.set(b.id, b);
    }
    return this.byId.get(bodyId);
  }

  /** Set the idle edge color and repaint every idle edge to it. */
  setEdgeBase(color: THREE.Color) {
    this.edgeBase.copy(color);
    // one whole-buffer write per body rather than one upload per edge, this
    // fires on every fillet/chamfer tool activation, over every edge in the model
    const skip = (e: EdgeRef) => e === this.hoveredEdge || this.selectedEdges.has(e) || this.errorEdges.has(e);
    for (const draw of edgeObjects(this.view)) draw.setColorAll(this.edgeBase, skip);
  }

  /** Replaces the previous error set. Error beats select beats hover, until a rebuild re-derives the set from the latest
   *  diagnostics. */
  setErrorEdges(lines: EdgeRef[]) {
    const next = new Set(lines);
    for (const e of this.errorEdges) {
      if (next.has(e)) continue;
      // no longer failing, restore whatever tier it belongs to now
      if (this.selectedEdges.has(e)) this.tint(e, SELECT);
      else if (e === this.hoveredEdge) this.tint(e, HOVER);
      else paintIdle(e, this.edgeBase);
    }
    this.errorEdges = next;
    for (const e of this.errorEdges) paint(e, ERROR);
  }

  hoverEdge(line: EdgeRef | null) {
    if (this.hoveredEdge === line) return;
    if (this.hoveredEdge && !this.selectedEdges.has(this.hoveredEdge) && !this.errorEdges.has(this.hoveredEdge)) {
      paintIdle(this.hoveredEdge, this.edgeBase);
    }
    this.hoveredEdge = line;
    if (line && !this.selectedEdges.has(line) && !this.errorEdges.has(line)) {
      this.tint(line, HOVER);
    }
  }

  /** What hover has lit, to tell whether a pointer move changed the picture. */
  hoverState(): HoverState {
    return { body: this.hoveredBody, edge: this.hoveredEdge, faces: this.hoveredFaces };
  }

  hoverFace(faceId: number | null) {
    this.hoverFaceRun(faceId == null ? [] : [faceId]);
  }

  /** Hover a whole run of faces at once. `[]` is "nothing hovered". */
  hoverFaceRun(faceIds: readonly number[]) {
    const was = this.hoveredFaces;
    if (was.length === faceIds.length && was.every((f, i) => f === faceIds[i])) return;
    const now = new Set(faceIds);
    // Only faces leaving the hover are restored: repainting the whole run would flicker the members staying.
    for (const f of was) {
      if (!now.has(f) && !this.selectedFaces.has(f)) this.restoreFace(f);
    }
    const before = new Set(was);
    this.hoveredFaces = faceIds;
    this.faceBodies = null;
    for (const f of faceIds) {
      if (!before.has(f) && !this.selectedFaces.has(f)) this.paintFace(f, HOVER);
    }
    this.syncHoverOverlay();
  }

  private syncHoverOverlay() {
    const faces = this.hoveredFaces.filter((f) => {
      if (this.selectedFaces.has(f)) return false;
      const body = bodyOfFace(this.view, f);
      return !!body && this.bodyGlows.has(body.id);
    });
    const key = faces.join(",");
    const cur = this.hoverOverlay;
    if (!faces.length) {
      if (cur?.shown) this.showOverlay(cur, faces);
      return;
    }
    if (cur && cur.key === key) {
      if (!cur.shown) this.showOverlay(cur, faces);
      return;
    }
    if (cur) this.dropHoverOverlay();
    if (!faces.length) return;
    const next = { key, meshes: [] as THREE.Mesh[], shown: false };
    const byBody = new Map<BodyMesh, number[]>();
    for (const f of faces) {
      const body = bodyOfFace(this.view, f)!;
      const tris = body.faceTriangles.get(f);
      if (!tris) continue;
      const list = byBody.get(body) ?? [];
      pushAll(list, tris);
      byBody.set(body, list);
    }
    for (const [body, tris] of byBody) {
      const pos = body.mesh.geometry.getAttribute("position");
      const index = body.mesh.geometry.getIndex();
      if (!pos || !index) continue;
      const out = new Float32Array(tris.length * 9);
      let o = 0;
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          const v = index.getX(t * 3 + k);
          out[o++] = pos.getX(v);
          out[o++] = pos.getY(v);
          out[o++] = pos.getZ(v);
        }
      }
      const mesh = makeFaceHoverOverlay(out, HOVER);
      mesh.userData.body = body.id;
      next.meshes.push(mesh);
    }
    this.hoverOverlay = next;
    this.showOverlay(next, faces);
  }

  private dropHoverOverlay() {
    for (const m of this.hoverOverlay?.meshes ?? []) disposeFaceHoverOverlay(m);
    this.hoverOverlay = null;
  }

  /** Called before the viewport replaces the highlighter on a rebuild. The cached hover overlay is off every mesh while
   *  hidden, so nothing else would reach it. */
  dispose() {
    this.dropHoverOverlay();
  }

  private showOverlay(o: { meshes: THREE.Mesh[]; shown: boolean }, faces: readonly number[]) {
    if (!faces.length) {
      for (const m of o.meshes) m.removeFromParent();
      o.shown = false;
      return;
    }
    for (const m of o.meshes) this.bodyById(m.userData.body as string)?.mesh.add(m);
    o.shown = true;
  }

  clearHover() {
    this.hoverEdge(null);
    this.hoverFace(null);
  }

  toggleSelectEdge(line: EdgeRef) {
    // membership always updates; the visible tint only changes when the edge
    // isn't in the error set (error paint has top precedence).
    if (this.selectedEdges.has(line)) {
      this.selectedEdges.delete(line);
      if (!this.errorEdges.has(line)) paintIdle(line, this.edgeBase);
    } else {
      this.selectedEdges.add(line);
      if (!this.errorEdges.has(line)) this.tint(line, SELECT);
    }
  }

  toggleSelectFace(faceId: number) {
    this.faceBodies = null;
    if (this.selectedFaces.has(faceId)) {
      this.selectedFaces.delete(faceId);
      this.restoreFace(faceId);
    } else {
      this.selectedFaces.add(faceId);
      this.paintFace(faceId, SELECT);
    }
    this.syncHoverOverlay();
  }

  /** Adds without toggling, so the second sweep of a box over an overlap does not eat the first one's result. */
  selectEdge(line: EdgeRef) {
    if (!this.selectedEdges.has(line)) this.toggleSelectEdge(line);
  }

  selectFace(faceId: number) {
    if (!this.selectedFaces.has(faceId)) this.toggleSelectFace(faceId);
  }

  selectBody(bodyId: string) {
    if (!this.selectedBodies.has(bodyId)) this.toggleSelectBody(bodyId);
  }

  /** the currently selected edge lines (for pre-selected fillet/chamfer). */
  getSelectedEdges(): EdgeRef[] {
    return [...this.selectedEdges];
  }

  /** the currently selected face ids (for pre-selected press/pull). */
  getSelectedFaces(): number[] {
    return [...this.selectedFaces];
  }

  clearSelection() {
    for (const e of this.selectedEdges) {
      if (!this.errorEdges.has(e)) paintIdle(e, this.edgeBase);
    }
    for (const f of this.selectedFaces) this.restoreFace(f);
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this.faceBodies = null;
    this.syncHoverOverlay();
  }

  toggleSelectBody(bodyId: string) {
    if (this.selectedBodies.has(bodyId)) {
      this.selectedBodies.delete(bodyId);
      // if the cursor is still on it, drop back to the hover glow rather than none
      if (this.hoveredBody === bodyId) this.showBodyGlow(bodyId, "hover");
      else this.hideBodyGlow(bodyId);
    } else {
      this.selectedBodies.add(bodyId);
      this.showBodyGlow(bodyId, "select");
    }
  }

  /** For a tool asking which body. A selected body keeps the selected colour as the cursor passes over it. */
  hoverBody(bodyId: string | null) {
    if (this.hoveredBody === bodyId) return;
    if (this.hoveredBody !== null && !this.selectedBodies.has(this.hoveredBody)) {
      this.hideBodyGlow(this.hoveredBody);
    }
    this.hoveredBody = bodyId;
    if (bodyId !== null && !this.selectedBodies.has(bodyId)) this.showBodyGlow(bodyId, "hover");
  }

  /** select exactly this body (clearing any other body selection). */
  selectOnlyBody(bodyId: string) {
    this.clearBodySelection();
    this.toggleSelectBody(bodyId);
  }

  getSelectedBodies(): string[] {
    return [...this.selectedBodies];
  }

  /** Bodies with anything selected, hovered or failing on them, into `out`. */
  markedBodies(out: Set<string>): Set<string> {
    for (const b of this.selectedBodies) out.add(b);
    if (this.hoveredBody) out.add(this.hoveredBody);
    for (const set of [this.selectedEdges, this.errorEdges]) for (const e of set) if (e.body) out.add(e.body);
    if (this.hoveredEdge?.body) out.add(this.hoveredEdge.body);
    if (!this.faceBodies) {
      this.faceBodies = new Set();
      for (const set of [this.selectedFaces, this.hoveredFaces]) {
        for (const f of set) {
          const b = bodyOfFace(this.view, f);
          if (b) this.faceBodies.add(b.id);
        }
      }
    }
    for (const b of this.faceBodies) out.add(b);
    return out;
  }

  clearBodySelection() {
    for (const id of this.selectedBodies) {
      // Keep the hovered body's glow, but drop it to the fainter hover intensity.
      if (id === this.hoveredBody) this.showBodyGlow(id, "hover");
      else this.hideBodyGlow(id);
    }
    this.selectedBodies.clear();
    // A body under the cursor that was never selected still needs its hover glow.
    if (this.hoveredBody !== null && !this.bodyGlows.has(this.hoveredBody)) {
      this.showBodyGlow(this.hoveredBody, "hover");
    }
  }

  /** A fresnel overlay child of the mesh (selectionGlow.ts), replacing any glow on it so a hover turning into a selection
   *  swaps intensity rather than stacking two draws. */
  private showBodyGlow(bodyId: string, kind: GlowKind) {
    const body = this.bodyById(bodyId);
    if (!body) return;
    this.hideBodyGlow(bodyId);
    const glow = makeSelectionGlow(body.mesh.geometry, kind);
    body.mesh.add(glow);
    this.bodyGlows.set(bodyId, glow);
    this.syncHoverOverlay();
  }

  /** Remove a body's glow. Neither half is disposed: the geometry is the body's
   *  and the material is shared by every glow (selectionGlow.ts). */
  private hideBodyGlow(bodyId: string) {
    const glow = this.bodyGlows.get(bodyId);
    if (!glow) return;
    glow.removeFromParent();
    this.bodyGlows.delete(bodyId);
    this.syncHoverOverlay();
  }

  private paintShown = true;

  private tint(e: EdgeRef, color: THREE.Color) {
    if (this.paintShown) paint(e, color);
    else paintIdle(e, this.edgeBase);
  }

  /** Off, the sets keep following clicks so the tree and properties still do; a failing edge stays red either way. */
  setPaintShown(on: boolean) {
    if (on === this.paintShown) return;
    if (on) {
      this.paintShown = true;
      this.repaintSelection();
    } else {
      this.stripSelection();
      this.paintShown = false;
    }
  }

  private stripSelection() {
    for (const f of new Set([...this.selectedFaces, ...this.hoveredFaces])) this.restoreFace(f);
    const edges = new Set(this.selectedEdges);
    if (this.hoveredEdge) edges.add(this.hoveredEdge);
    for (const e of edges) if (!this.errorEdges.has(e)) paintIdle(e, this.edgeBase);
  }

  private repaintSelection() {
    for (const f of new Set([...this.selectedFaces, ...this.hoveredFaces])) {
      this.paintFace(f, this.selectedFaces.has(f) ? SELECT : HOVER);
    }
    for (const e of this.selectedEdges) if (!this.errorEdges.has(e)) this.tint(e, SELECT);
    const h = this.hoveredEdge;
    if (h && !this.selectedEdges.has(h) && !this.errorEdges.has(h)) this.tint(h, HOVER);
  }

  /** Run `fn` with every selected, hovered and failing face and edge in its
   *  plain colour, then paint those tints back. A saved picture shows none of them. */
  withoutSelectionPaint<T>(fn: () => T): T {
    const faces = new Set([...this.selectedFaces, ...this.hoveredFaces]);
    const edges = new Set([...this.selectedEdges, ...this.errorEdges]);
    if (this.hoveredEdge) edges.add(this.hoveredEdge);
    for (const f of faces) this.restoreFace(f);
    for (const e of edges) paintIdle(e, this.edgeBase);
    try {
      return fn();
    } finally {
      for (const f of faces) this.paintFace(f, this.selectedFaces.has(f) ? SELECT : HOVER);
      for (const e of edges) {
        if (this.errorEdges.has(e)) paint(e, ERROR);
        else if (this.selectedEdges.has(e)) this.tint(e, SELECT);
        else this.tint(e, HOVER);
      }
    }
  }

  private paintFace(faceId: number, color: THREE.Color) {
    if (!this.paintShown) return;
    const body = bodyOfFace(this.view, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return;
    const colorAttr = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const index = body.mesh.geometry.getIndex();
    if (!colorAttr || !index) return;
    const range = this.forEachVertex(tris, index, (v) => {
      colorAttr.setXYZ(v, color.r, color.g, color.b);
    });
    if (range) this.uploadRange(colorAttr, range);
  }

  /** Restore one face's live color to its current base (BASE_COLOR, or the
   *  component/draft analysis color if an analysis is active). */
  private restoreFace(faceId: number) {
    const body = bodyOfFace(this.view, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return;
    const colorAttr = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const index = body.mesh.geometry.getIndex();
    if (!colorAttr || !index) return;
    const base = body.baseColors;
    const range = this.forEachVertex(tris, index, (v) => {
      const r = base[v * 3],
        g = base[v * 3 + 1],
        b = base[v * 3 + 2];
      if (r !== undefined && g !== undefined && b !== undefined) colorAttr.setXYZ(v, r, g, b);
    });
    if (range) this.uploadRange(colorAttr, range);
  }

  /** Run `fn` over every vertex of the given triangle indices, returning the
   *  touched [minVertex, maxVertex] span (or null if `tris` was empty). */
  private forEachVertex(
    tris: number[],
    index: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    fn: (v: number) => void,
  ): [number, number] | null {
    let lo = Infinity,
      hi = -Infinity;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        fn(v);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return lo <= hi ? [lo, hi] : null;
  }

  /** Scope the GPU upload of a color-attribute edit to the touched vertex span
   *  (in vertex indices, inclusive) instead of re-uploading the whole buffer. */
  private uploadRange(attr: THREE.BufferAttribute, [lo, hi]: [number, number]) {
    attr.addUpdateRange(lo * 3, (hi - lo + 1) * 3);
    attr.needsUpdate = true;
  }

  /** The per-face base colour (component or draft analysis); `() => BASE_COLOR` clears it. Selected faces keep their tint
   *  but take the new base for deselect. faceIds are global, so each body repaints only its own. */
  setBase(colorOf: (faceId: number) => THREE.Color, only?: Iterable<BodyMesh>) {
    const cache = new Map<number, THREE.Color>();
    // A progressive load paints each chunk's bodies as they arrive; without `only` each chunk would re-upload the whole
    // model (0.39 s at 3,071 bodies).
    for (const body of only ?? this.view.bodies) {
      const colorAttr = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
      const index = body.mesh.geometry.getIndex();
      if (!colorAttr || !index) continue;
      const ids = body.faceIds;
      const base = body.baseColors;
      for (let t = 0; t < ids.length; t++) {
        const fid = ids[t];
        if (fid === undefined) continue;
        let col = cache.get(fid);
        if (!col) {
          col = colorOf(fid);
          cache.set(fid, col);
        }
        const selected = this.selectedFaces.has(fid);
        for (let k = 0; k < 3; k++) {
          const v = index.getX(t * 3 + k);
          base[v * 3] = col.r;
          base[v * 3 + 1] = col.g;
          base[v * 3 + 2] = col.b;
          if (!selected) colorAttr.setXYZ(v, col.r, col.g, col.b);
        }
      }
      // A full buffer rewrite, so drop partial ranges a prior paintFace queued, or the renderer replays a stale sub-range.
      colorAttr.clearUpdateRanges();
      colorAttr.needsUpdate = true;
      body.baseVersion = (body.baseVersion ?? 0) + 1;
    }
  }
}
