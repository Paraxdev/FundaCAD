// Highlighting without post-processing: an edge recolours its span of its body's instance colour buffer, a face its own
// vertex colour range (per-face tessellation keeps each face's vertices distinct) and is drawn again as a translucent
// overlay, which is all a Path traced view, glass or an untinted Matcap shows of it.

import * as THREE from "three";
import { bodyOfFace, edgeObjects, type BodyMesh, type ModelView } from "./render";
import type { BodyEdges, EdgePt, EdgeRef } from "./edgeLines";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { segmentPositions } from "./edgeEmphasis";
import { markOverlay } from "./overlayKinds";
import {
  disposeFaceHoverOverlay,
  makeFaceHoverOverlay,
  makeSelectionGlow,
  removeSelectionGlows,
  type GlowKind,
} from "./selectionGlow";
import { themeColor } from "./themeColors";
import { onThemeChange } from "../ui/theme";
import { PICK_ALPHA, composite, pickColor, type PickKind } from "./pickColors";
import { uploadSpan, uploadWhole } from "./gpuUpload";

const EDGE_BASE = new THREE.Color(0x1b1f24);
/** Px. An idle edge is 1.6 (edgeLines.ts EDGE_IDLE_WIDTH), so a pick stays thin enough to show which edge it is. */
const EDGE_PICK_WIDTH: Record<PickKind, number> = { hover: 2.4, select: 3 };
const EDGE_PICK_NAME = "edge-pick-line";
const edgePickMaterials = new Map<PickKind, LineMaterial>();

/** Shared and never disposed, as the glow materials are, so a hover crossing edges never relinks a program. */
function edgePickMaterial(kind: PickKind): LineMaterial {
  let m = edgePickMaterials.get(kind);
  if (!m) {
    m = new LineMaterial({
      color: 0xffffff,
      vertexColors: true,
      linewidth: EDGE_PICK_WIDTH[kind],
      worldUnits: false,
      depthTest: true,
      depthWrite: false,
      transparent: true,
    });
    edgePickMaterials.set(kind, m);
  }
  return m;
}

function removeEdgePickLines(draw: BodyEdges | undefined) {
  const obj = draw?.object;
  if (!obj) return;
  for (let i = obj.children.length - 1; i >= 0; i--) {
    const c = obj.children[i]!;
    if (c.name !== EDGE_PICK_NAME) continue;
    c.removeFromParent();
    (c as LineSegments2).geometry.dispose();
  }
}
interface SelectLine {
  line: LineSegments2;
  edges: EdgeRef[];
  /** Each edge's first float in `col`, plus the end. */
  starts: number[];
  hexes: number[];
  /** Held by reference by the line geometry, so a recolour writes into it. */
  col: Float32Array;
}

const pickLineFits = (e: EdgeRef) => !!e.draw?.object && (e.points?.length ?? 0) >= 2;

function makePickLine(draw: BodyEdges, kind: PickKind, pos: Float32Array, col: Float32Array): LineSegments2 {
  const geo = new LineSegmentsGeometry();
  geo.setPositions(pos);
  geo.setColors(col);
  const mat = edgePickMaterial(kind);
  const line = new LineSegments2(geo, mat);
  line.name = EDGE_PICK_NAME;
  line.raycast = () => {};
  line.renderOrder = draw.object.renderOrder + 1;
  line.frustumCulled = false;
  // The material is shared, so the viewport's resolution is copied in per draw from the edge's own material.
  line.onBeforeRender = () => {
    const r = draw.material?.resolution;
    if (r) mat.resolution.copy(r);
  };
  markOverlay(line, "edges");
  draw.object.add(line);
  return line;
}

function disposePickLine(line: LineSegments2) {
  line.removeFromParent();
  line.geometry.dispose();
}

/** Every vertex of a body by a grid cell of its position, with the face it belongs to. */
interface VertexIndex {
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  cell: number;
  tol2: number;
  face: Int32Array;
  cells: Map<number, number[]>;
}

const cellKey = (x: number, y: number, z: number) =>
  Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);

function buildVertexIndex(body: BodyMesh): VertexIndex | null {
  const geo = body.mesh.geometry;
  const pos = geo.getAttribute("position");
  const index = geo.getIndex();
  if (!pos || !index) return null;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const size = geo.boundingBox!.getSize(new THREE.Vector3()).length();
  // A cell twice the match distance and more, so a point and a vertex it matches round to neighbouring cells at most.
  const cell = size * 1e-4 + 1e-9;
  const tol = size * 1e-5 + 1e-9;
  const face = new Int32Array(pos.count).fill(-1);
  const n = index.count;
  for (let i = 0; i < n; i++) {
    const f = body.faceIds[(i / 3) | 0];
    if (f !== undefined) face[index.getX(i)] = f;
  }
  const cells = new Map<number, number[]>();
  for (let v = 0; v < pos.count; v++) {
    if (face[v]! < 0) continue;
    const k = cellKey(Math.round(pos.getX(v) / cell), Math.round(pos.getY(v) / cell), Math.round(pos.getZ(v) / cell));
    const list = cells.get(k);
    if (list) list.push(v);
    else cells.set(k, [v]);
  }
  return { pos, cell, tol2: tol * tol, face, cells };
}

function facesAt(idx: VertexIndex, p: EdgePt): Set<number> {
  const out = new Set<number>();
  const q = p.map((c) => c / idx.cell);
  const xs = [...new Set([Math.floor(q[0]!), Math.ceil(q[0]!)])];
  const ys = [...new Set([Math.floor(q[1]!), Math.ceil(q[1]!)])];
  const zs = [...new Set([Math.floor(q[2]!), Math.ceil(q[2]!)])];
  for (const x of xs)
    for (const y of ys)
      for (const z of zs) {
        for (const v of idx.cells.get(cellKey(x, y, z)) ?? []) {
          const d = (idx.pos.getX(v) - p[0]) ** 2 + (idx.pos.getY(v) - p[1]) ** 2 + (idx.pos.getZ(v) - p[2]) ** 2;
          if (d <= idx.tol2) out.add(idx.face[v]!);
        }
      }
  return out;
}

const DEFAULT_ACCENT = 0x9a9ff0;
const DEFAULT_BODY = 0x9aa7b4;

const accent = () => themeColor("--accent", DEFAULT_ACCENT);
const ground = () => themeColor("--viewport-bg", 0x0b0912);

/** A selected edge over the default body: a fillet or chamfer tool's ghost member lines. */
export function edgeSelectColor(): number {
  return pickColor(accent(), [DEFAULT_BODY, ground()], "select", "edge");
}

/** An edge in the hover tier over the default body: the emphasis line, a ghost edge and the origin axis hover. */
export function edgeHoverColor(): number {
  const pick = pickColor(accent(), [DEFAULT_BODY, ground()], "hover", "edge");
  return composite(DEFAULT_BODY, pick, PICK_ALPHA.edge.hover);
}
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

interface PickOverlay {
  key: string;
  meshes: THREE.Mesh[];
  shown: boolean;
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

// Bodies whose colour buffer may hold a hover or selection tint that the base colours do not.
const tinted = new WeakSet<BodyMesh>();

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

  private accent = accent();
  private ground = ground();
  /** Pick colours by the colour under them, kind and part, emptied on a theme change. */
  private colours = new Map<string, THREE.Color>();
  private offTheme: () => void;

  constructor(private view: ModelView) {
    for (const b of view.bodies) {
      removeSelectionGlows(b.mesh);
      if (tinted.delete(b)) this.stripTint(b);
    }
    for (const draw of edgeObjects(view)) removeEdgePickLines(draw);
    this.offTheme = onThemeChange(() => this.refreshTheme());
  }

  private hoverLine: { line: LineSegments2; edge: EdgeRef; hex: number } | null = null;
  private selectLines = new Map<BodyEdges, SelectLine>();
  /** The selected set changed, so the selected lines are rebuilt; otherwise only their colours are rewritten. */
  private selectDirty = false;
  /** Lines of the draws whose selected edges or their colours changed, redone alone unless `selectDirty`. */
  private rebuildDraws = new Set<BodyEdges>();
  private recolourDraws = new Set<BodyEdges>();
  private edgeLinesQueued = false;

  /** A box select adds edges one at a time, so the wide lines are rebuilt once after the batch. */
  private queueEdgeLines() {
    if (this.edgeLinesQueued) return;
    this.edgeLinesQueued = true;
    queueMicrotask(() => this.runEdgeLines());
  }

  private runEdgeLines() {
    if (!this.edgeLinesQueued) return;
    this.edgeLinesQueued = false;
    if (!this.disposed) this.syncEdgeLines();
  }

  /** The picked edges drawn again wide over their own one. */
  private syncEdgeLines() {
    this.syncHoverLine();
    if (this.selectDirty) this.rebuildSelectLines();
    else {
      if (this.rebuildDraws.size) this.rebuildSelectLines(this.rebuildDraws);
      if (this.recolourDraws.size) this.recolourSelectLines(this.recolourDraws, this.rebuildDraws);
    }
    this.selectDirty = false;
    this.rebuildDraws.clear();
    this.recolourDraws.clear();
  }

  private syncHoverLine() {
    const h = this.hoveredEdge;
    const on =
      h && this.paintShown && !this.selectedEdges.has(h) && !this.errorEdges.has(h) && pickLineFits(h) ? h : null;
    const cur = this.hoverLine;
    if (!on) {
      if (cur) disposePickLine(cur.line);
      this.hoverLine = null;
      return;
    }
    const c = this.edgeColour(on, "hover");
    const hex = c.getHex();
    if (cur && cur.edge === on && cur.hex === hex) return;
    if (cur) disposePickLine(cur.line);
    const pos = segmentPositions(on.points);
    const col = new Float32Array(pos.length);
    for (let k = 0; k < pos.length; k += 3) col.set([c.r, c.g, c.b], k);
    this.hoverLine = { line: makePickLine(on.draw, "hover", pos, col), edge: on, hex };
  }

  private rebuildSelectLines(only?: ReadonlySet<BodyEdges>) {
    for (const [draw, g] of this.selectLines) {
      if (only && !only.has(draw)) continue;
      disposePickLine(g.line);
      this.selectLines.delete(draw);
    }
    if (!this.paintShown) return;
    let draws = only;
    if (!draws) {
      const all = new Set<BodyEdges>();
      for (const e of this.selectedEdges) if (pickLineFits(e)) all.add(e.draw);
      draws = all;
    }
    // A draw's line lists its edges in the draw's order, so a box frame redoes it from that draw's edges alone.
    const byDraw = new Map<BodyEdges, EdgeRef[]>();
    for (const draw of draws) {
      const edges = draw.refs.filter((e) => this.selectedEdges.has(e) && !this.errorEdges.has(e) && pickLineFits(e));
      if (edges.length) byDraw.set(draw, edges);
    }
    for (const [draw, edges] of byDraw) {
      const parts = edges.map((e) => segmentPositions(e.points));
      const pos = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      const col = new Float32Array(pos.length);
      const starts: number[] = [];
      const hexes: number[] = [];
      let o = 0;
      edges.forEach((e, i) => {
        const c = this.edgeColour(e, "select");
        const p = parts[i]!;
        pos.set(p, o);
        for (let k = 0; k < p.length; k += 3) col.set([c.r, c.g, c.b], o + k);
        starts.push(o);
        hexes.push(c.getHex());
        o += p.length;
      });
      starts.push(o);
      this.selectLines.set(draw, { line: makePickLine(draw, "select", pos, col), edges, starts, hexes, col });
    }
  }

  /** Writes only the edges whose colour changed into the line's colour buffer, which three uploads again. */
  private recolourSelectLines(only: ReadonlySet<BodyEdges>, rebuilt: ReadonlySet<BodyEdges>) {
    for (const [draw, g] of this.selectLines) {
      if (!only.has(draw) || rebuilt.has(draw)) continue;
      let changed = false;
      g.edges.forEach((e, i) => {
        const c = this.edgeColour(e, "select");
        const hex = c.getHex();
        if (hex === g.hexes[i]) return;
        g.hexes[i] = hex;
        for (let k = g.starts[i]!; k < g.starts[i + 1]!; k += 3) g.col.set([c.r, c.g, c.b], k);
        changed = true;
      });
      if (!changed) continue;
      const attr = g.line.geometry.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute | undefined;
      if (attr) attr.data.needsUpdate = true;
    }
  }

  private pickLines(): LineSegments2[] {
    const out = [...this.selectLines.values()].map((g) => g.line);
    if (this.hoverLine) out.push(this.hoverLine.line);
    return out;
  }

  private dropPickLines() {
    for (const l of this.pickLines()) disposePickLine(l);
    this.selectLines.clear();
    this.hoverLine = null;
  }

  /** Re-read the accent and repaint every face, overlay and edge it coloured. */
  refreshTheme() {
    const next = accent();
    if (next === this.accent && ground() === this.ground) return;
    this.accent = next;
    this.ground = ground();
    this.colours.clear();
    this.dropOverlays();
    if (this.paintShown) this.repaintSelection();
    this.syncOverlays();
  }

  private pickColour(under: number | number[], kind: PickKind, part: "face" | "edge"): THREE.Color {
    const key = `${String(under)}:${kind}:${part}`;
    let c = this.colours.get(key);
    if (!c) {
      const unders = typeof under === "number" ? [under] : under;
      // An edge is also seen against the ground along a silhouette.
      const pick = pickColor(this.accent, part === "edge" ? [...unders, this.ground] : unders, kind, part);
      c = new THREE.Color(part === "edge" ? composite(unders[0]!, pick, PICK_ALPHA.edge[kind]) : pick);
      this.colours.set(key, c);
    }
    return c;
  }

  /** The face's own base colour as sRGB hex, read off its first vertex. */
  private faceUnder(body: BodyMesh, faceId: number): number {
    const t = body.faceTriangles.get(faceId)?.[0];
    const index = body.mesh.geometry.getIndex();
    const v = t === undefined || !index ? 0 : index.getX(t * 3);
    return this.underAt(body, v);
  }

  private underAt(body: BodyMesh, v: number): number {
    const b = body.baseColors;
    if (!b || b.length < v * 3 + 3) return DEFAULT_BODY;
    return new THREE.Color(b[v * 3]!, b[v * 3 + 1]!, b[v * 3 + 2]!).getHex();
  }

  private faceColour(faceId: number, kind: PickKind): THREE.Color {
    const body = bodyOfFace(this.view, faceId);
    return this.pickColour(body ? this.faceUnder(body, faceId) : DEFAULT_BODY, kind, "face");
  }

  /** Against every face beside it, so the harder of a light and a dark neighbour decides. */
  private edgeColour(e: EdgeRef, kind: PickKind): THREE.Color {
    const body = e.body ? this.bodyById(e.body) : undefined;
    if (!body) return this.pickColour(DEFAULT_BODY, kind, "edge");
    const faces = this.facesBeside(body, e);
    // A selected face beside it shows its pick colour, which the edge has to stand out from too.
    const shown = (f: number) =>
      this.selectedFaces.has(f) && this.paintShown ? this.faceColour(f, "select").getHex() : this.faceUnder(body, f);
    const unders = faces.length ? faces.map(shown) : [this.underAt(body, 0)];
    return this.pickColour(unders, kind, "edge");
  }

  private edgeFaces = new Map<EdgeRef, number[]>();
  private vertexIndexes = new Map<BodyMesh, VertexIndex | null>();

  /** The faces with a vertex at both ends of the edge's first segment, which per face tessellation shares. */
  private facesBeside(body: BodyMesh, e: EdgeRef): number[] {
    const hit = this.edgeFaces.get(e);
    if (hit) return hit;
    const a = e.points?.[0];
    const b = e.points?.[1] ?? a;
    let idx = this.vertexIndexes.get(body);
    if (idx === undefined) {
      idx = buildVertexIndex(body);
      this.vertexIndexes.set(body, idx);
    }
    const out: number[] = [];
    if (idx && a && b) {
      const atB = facesAt(idx, b);
      for (const f of facesAt(idx, a)) if (atB.has(f)) out.push(f);
    }
    this.edgeFaces.set(e, out);
    return out;
  }

  /** A reused body keeps the tint its last highlighter painted, and the repaint that used to wipe it now skips it. */
  private stripTint(body: BodyMesh) {
    const colorAttr = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
    if (!colorAttr) return;
    colorAttr.array.set(body.baseColors);
    uploadWhole(colorAttr);
  }

  /** Built once: a linear find per painted body scans thousands on an import. No invalidation needed, setModel() builds a
   *  fresh ModelView and Highlighter together. */
  private byId: Map<string, BodyMesh> | null = null;

  /** Selection and hover overlay per body (selectionGlow.ts), parented to its mesh so it follows a move ghost drag and
   *  goes with the model. */
  private bodyGlows = new Map<string, THREE.Mesh>();
  /** Kept by key once taken down, since every pointer move clears the hover and sets it again. */
  private overlays: Record<PickKind, PickOverlay | null> = { hover: null, select: null };
  private selectOverlayQueued = false;
  /** Bodies whose selected faces changed since the shown select overlay was built, null when any may have. */
  private overlayMoved: Set<string> | null = null;
  private disposed = false;

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
      if (this.selectedEdges.has(e)) this.tint(e, "select");
      else if (e === this.hoveredEdge) this.tint(e, "hover");
      else paintIdle(e, this.edgeBase);
    }
    this.errorEdges = next;
    for (const e of this.errorEdges) paint(e, ERROR);
    this.selectDirty = true;
    this.queueEdgeLines();
  }

  hoverEdge(line: EdgeRef | null) {
    if (this.hoveredEdge === line) return;
    if (this.hoveredEdge && !this.selectedEdges.has(this.hoveredEdge) && !this.errorEdges.has(this.hoveredEdge)) {
      paintIdle(this.hoveredEdge, this.edgeBase);
    }
    this.hoveredEdge = line;
    if (line && !this.selectedEdges.has(line) && !this.errorEdges.has(line)) {
      this.tint(line, "hover");
    }
    this.queueEdgeLines();
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
      if (!before.has(f) && !this.selectedFaces.has(f)) this.paintFace(f, "hover");
    }
    this.syncOverlay("hover");
  }

  private syncOverlays() {
    this.syncOverlay("hover");
    this.syncOverlay("select");
  }

  /** A box select adds faces one at a time, so the selected overlay is rebuilt once after the batch. */
  private queueSelectOverlay(moved?: ReadonlySet<string>) {
    if (!moved) this.overlayMoved = null;
    else if (this.overlayMoved) for (const b of moved) this.overlayMoved.add(b);
    if (this.selectOverlayQueued) return;
    this.selectOverlayQueued = true;
    queueMicrotask(() => this.runSelectOverlay());
  }

  private runSelectOverlay() {
    if (!this.selectOverlayQueued) return;
    this.selectOverlayQueued = false;
    if (!this.disposed) this.syncOverlay("select", this.overlayMoved ?? undefined);
  }

  /** Builds the overlay and wide lines queued in this task now, for a render loop about to draw the frame. */
  settle() {
    this.runSelectOverlay();
    this.runEdgeLines();
  }

  private syncOverlay(kind: PickKind, moved?: ReadonlySet<string>) {
    if (kind === "hover") return this.buildOverlay("hover");
    const cur = this.overlays.select;
    if (moved && cur?.shown && this.selectedFaces.size && this.paintShown) this.patchSelectOverlay(cur, moved);
    else this.buildOverlay("select");
    this.overlayMoved = this.overlays.select?.shown ? new Set() : null;
  }

  /** A box frame moves a few bodies' faces, so only their meshes are built again, in the order a full build keeps. */
  private patchSelectOverlay(cur: PickOverlay, moved: ReadonlySet<string>) {
    if (!moved.size) return;
    const next: PickOverlay = { key: "", meshes: [], shown: false };
    for (const m of cur.meshes) {
      if (moved.has(m.userData.body as string)) disposeFaceHoverOverlay(m);
      else next.meshes.push(m);
    }
    for (const id of moved) {
      const body = this.bodyById(id);
      if (!body) continue;
      const fids: number[] = [];
      for (let f = body.faceStart; f < body.faceStart + body.faceCount; f++) {
        if (this.selectedFaces.has(f) && body.faceTriangles.has(f)) fids.push(f);
      }
      const mesh = fids.length ? this.overlayMesh(body, fids, "select") : null;
      if (mesh) next.meshes.push(mesh);
    }
    const start = (m: THREE.Mesh) => this.bodyById(m.userData.body as string)?.faceStart ?? 0;
    next.meshes.sort((a, b) => start(a) - start(b));
    this.overlays.select = next;
    this.showOverlay(next, true);
  }

  private buildOverlay(kind: PickKind) {
    const faces =
      kind === "hover"
        ? this.hoveredFaces.filter((f) => !this.selectedFaces.has(f))
        : [...this.selectedFaces].sort((a, b) => a - b);
    const cur = this.overlays[kind];
    if (!faces.length || !this.paintShown) {
      if (cur?.shown) this.showOverlay(cur, false);
      return;
    }
    const key = faces.join(",");
    if (cur && cur.key === key) {
      if (!cur.shown) this.showOverlay(cur, true);
      return;
    }
    // A box frame moves a few bodies' faces, the meshes of the others are kept.
    const old = new Map<string, THREE.Mesh>();
    for (const m of cur?.meshes ?? []) old.set(m.userData.body as string, m);
    const next: PickOverlay = { key, meshes: [], shown: false };
    const byBody = new Map<BodyMesh, number[]>();
    for (const f of faces) {
      const body = bodyOfFace(this.view, f);
      if (!body?.faceTriangles.has(f)) continue;
      const list = byBody.get(body) ?? [];
      list.push(f);
      byBody.set(body, list);
    }
    for (const [body, fids] of byBody) {
      const bodyKey = fids.join(",");
      const kept = old.get(body.id);
      if (kept?.userData.key === bodyKey) {
        next.meshes.push(kept);
        old.delete(body.id);
        continue;
      }
      const mesh = this.overlayMesh(body, fids, kind);
      if (mesh) next.meshes.push(mesh);
    }
    for (const m of old.values()) disposeFaceHoverOverlay(m);
    this.overlays[kind] = next;
    this.showOverlay(next, true);
  }

  private overlayMesh(body: BodyMesh, fids: number[], kind: PickKind): THREE.Mesh | null {
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex();
    if (!pos || !index) return null;
    let n = 0;
    for (const f of fids) n += body.faceTriangles.get(f)!.length;
    const out = new Float32Array(n * 9);
    const col = new Float32Array(n * 9);
    let o = 0;
    for (const f of fids) {
      const c = this.faceColour(f, kind);
      for (const t of body.faceTriangles.get(f)!) {
        for (let k = 0; k < 3; k++) {
          const v = index.getX(t * 3 + k);
          col[o] = c.r;
          col[o + 1] = c.g;
          col[o + 2] = c.b;
          out[o++] = pos.getX(v);
          out[o++] = pos.getY(v);
          out[o++] = pos.getZ(v);
        }
      }
    }
    const mesh = makeFaceHoverOverlay(out, col, kind);
    mesh.userData.body = body.id;
    mesh.userData.key = fids.join(",");
    return mesh;
  }

  private dropOverlay(kind: PickKind) {
    for (const m of this.overlays[kind]?.meshes ?? []) disposeFaceHoverOverlay(m);
    this.overlays[kind] = null;
  }

  private dropOverlays() {
    this.dropOverlay("hover");
    this.dropOverlay("select");
  }

  /** Called before the viewport replaces the highlighter on a rebuild. The cached overlays are off every mesh while
   *  hidden, so nothing else would reach them. */
  dispose() {
    this.disposed = true;
    this.offTheme();
    this.dropOverlays();
    this.dropPickLines();
    this.vertexIndexes.clear();
    this.edgeFaces.clear();
  }

  private showOverlay(o: PickOverlay, on: boolean) {
    if (!on) {
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
      if (!this.errorEdges.has(line)) this.tint(line, "select");
    }
    this.rebuildDraws.add(line.draw);
    this.queueEdgeLines();
  }

  toggleSelectFace(faceId: number) {
    this.faceBodies = null;
    if (this.selectedFaces.has(faceId)) {
      this.selectedFaces.delete(faceId);
      this.restoreFace(faceId);
    } else {
      this.selectedFaces.add(faceId);
      this.paintFace(faceId, "select");
    }
    this.syncOverlay("hover");
    this.queueSelectOverlay();
    this.retintEdges();
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

  /** Moves the selection to exactly `want`, painting only what changed, so a box preview frame costs its delta and an
   *  unchanged one nothing. False when nothing changed. */
  setSelection(want: {
    faces: ReadonlySet<number>;
    edges: ReadonlySet<EdgeRef>;
    bodies: ReadonlySet<string>;
  }): boolean {
    const minus = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>) => {
      const out: T[] = [];
      for (const x of a) if (!b.has(x)) out.push(x);
      return out;
    };
    const dropFaces = minus(this.selectedFaces, want.faces);
    const addFaces = minus(want.faces, this.selectedFaces);
    const dropEdges = minus(this.selectedEdges, want.edges);
    const addEdges = minus(want.edges, this.selectedEdges);
    const flipBodies = minus(this.selectedBodies, want.bodies).concat(minus(want.bodies, this.selectedBodies));
    if (!dropFaces.length && !addFaces.length && !dropEdges.length && !addEdges.length && !flipBodies.length) {
      return false;
    }
    const hov = this.hoveredEdge;
    const hovWas = hov !== null && this.selectedEdges.has(hov);
    for (const f of dropFaces) {
      this.selectedFaces.delete(f);
      this.restoreFace(f);
    }
    for (const f of addFaces) {
      this.selectedFaces.add(f);
      this.paintFace(f, "select");
    }
    for (const e of dropEdges) {
      this.selectedEdges.delete(e);
      if (!this.errorEdges.has(e)) paintIdle(e, this.edgeBase);
      this.rebuildDraws.add(e.draw);
    }
    for (const e of addEdges) {
      this.selectedEdges.add(e);
      this.rebuildDraws.add(e.draw);
    }
    const fresh = new Set(addEdges);
    const moved = new Set([...dropFaces, ...addFaces]);
    const movedBodies = new Set<string>();
    for (const f of moved) {
      const b = bodyOfFace(this.view, f);
      if (b) movedBodies.add(b.id);
    }
    // An edge's pick colour stands out from the faces beside it, so only the edges beside a moved face change colour.
    const beside = (e: EdgeRef) => {
      const body = e.body && movedBodies.has(e.body) ? this.bodyById(e.body) : undefined;
      return body !== undefined && this.facesBeside(body, e).some((f) => moved.has(f));
    };
    for (const e of fresh) if (!this.errorEdges.has(e)) this.tint(e, "select");
    for (const id of movedBodies) {
      for (const e of this.bodyById(id)?.edges.refs ?? []) {
        if (this.selectedEdges.has(e) && !fresh.has(e) && !this.errorEdges.has(e) && beside(e)) this.tint(e, "select");
      }
    }
    if (hov && !this.selectedEdges.has(hov) && !this.errorEdges.has(hov) && (hovWas || (moved.size && beside(hov)))) {
      this.tint(hov, "hover");
    }
    if (moved.size) {
      this.faceBodies = null;
      this.syncOverlay("hover");
      this.queueSelectOverlay(movedBodies);
    }
    for (const b of flipBodies) this.toggleSelectBody(b);
    // The starters read the order, a Boolean targets the first body, so it is the take's and not the drag path's.
    this.selectedFaces = new Set(want.faces);
    this.selectedEdges = new Set(want.edges);
    this.selectedBodies = new Set(want.bodies);
    this.queueEdgeLines();
    return true;
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
    if (this.selectedEdges.size) this.selectDirty = true;
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this.faceBodies = null;
    this.retintEdges();
    this.syncOverlays();
    this.queueEdgeLines();
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
  }

  /** Remove a body's glow. Neither half is disposed: the geometry is the body's
   *  and the material is shared by every glow (selectionGlow.ts). */
  private hideBodyGlow(bodyId: string) {
    const glow = this.bodyGlows.get(bodyId);
    if (!glow) return;
    glow.removeFromParent();
    this.bodyGlows.delete(bodyId);
  }

  private paintShown = true;

  /** Picked edges again, after the colours beside them changed. */
  private retintEdges() {
    if (!this.paintShown) return;
    for (const e of this.selectedEdges) if (!this.errorEdges.has(e)) this.tint(e, "select");
    const h = this.hoveredEdge;
    if (h && !this.selectedEdges.has(h) && !this.errorEdges.has(h)) this.tint(h, "hover");
  }

  private tint(e: EdgeRef, kind: PickKind) {
    if (this.paintShown) paint(e, this.edgeColour(e, kind));
    else paintIdle(e, this.edgeBase);
    if (kind === "select") this.recolourDraws.add(e.draw);
    this.queueEdgeLines();
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
    this.syncOverlays();
    this.selectDirty = true;
    this.syncEdgeLines();
  }

  private stripSelection() {
    for (const f of new Set([...this.selectedFaces, ...this.hoveredFaces])) this.restoreFace(f);
    const edges = new Set(this.selectedEdges);
    if (this.hoveredEdge) edges.add(this.hoveredEdge);
    for (const e of edges) if (!this.errorEdges.has(e)) paintIdle(e, this.edgeBase);
  }

  private repaintSelection() {
    for (const f of new Set([...this.selectedFaces, ...this.hoveredFaces])) {
      this.paintFace(f, this.selectedFaces.has(f) ? "select" : "hover");
    }
    for (const e of this.selectedEdges) if (!this.errorEdges.has(e)) this.tint(e, "select");
    const h = this.hoveredEdge;
    if (h && !this.selectedEdges.has(h) && !this.errorEdges.has(h)) this.tint(h, "hover");
  }

  /** Run `fn` with every selected, hovered and failing face and edge in its
   *  plain colour, then paint those tints back. A saved picture shows none of them. */
  withoutSelectionPaint<T>(fn: () => T): T {
    const faces = new Set([...this.selectedFaces, ...this.hoveredFaces]);
    const edges = new Set([...this.selectedEdges, ...this.errorEdges]);
    if (this.hoveredEdge) edges.add(this.hoveredEdge);
    for (const f of faces) this.restoreFace(f);
    for (const e of edges) paintIdle(e, this.edgeBase);
    const overlays = [this.overlays.hover, this.overlays.select].filter((o) => o?.shown) as PickOverlay[];
    for (const o of overlays) this.showOverlay(o, false);
    const lines = this.pickLines().filter((l) => l.visible);
    for (const l of lines) l.visible = false;
    try {
      return fn();
    } finally {
      for (const o of overlays) this.showOverlay(o, true);
      for (const l of lines) l.visible = true;
      for (const f of faces) this.paintFace(f, this.selectedFaces.has(f) ? "select" : "hover");
      for (const e of edges) {
        if (this.errorEdges.has(e)) paint(e, ERROR);
        else if (this.selectedEdges.has(e)) this.tint(e, "select");
        else this.tint(e, "hover");
      }
    }
  }

  private paintFace(faceId: number, kind: PickKind) {
    // A hover is only the overlay's light wash, so it never reads as the full tint of a selection.
    if (!this.paintShown || kind === "hover") return;
    const color = this.faceColour(faceId, kind);
    const body = bodyOfFace(this.view, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return;
    const colorAttr = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const index = body.mesh.geometry.getIndex();
    if (!colorAttr || !index) return;
    tinted.add(body);
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
    uploadSpan(attr, lo * 3, (hi - lo + 1) * 3);
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
      uploadWhole(colorAttr);
      body.baseVersion = (body.baseVersion ?? 0) + 1;
    }
    // The pick colour is chosen against the base, so a new base recolours what is picked on it.
    this.retintEdges();
    if (this.selectedFaces.size || this.hoveredFaces.length) {
      for (const f of this.selectedFaces) this.paintFace(f, "select");
      this.dropOverlays();
      this.syncOverlays();
    }
  }
}
