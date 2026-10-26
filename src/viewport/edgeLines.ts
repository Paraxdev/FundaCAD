// One LineSegments2 per body with one shared LineMaterial: a Line2 per edge measured 348k objects, 12.2 GiB and 113 ms
// a frame of traversal in WebKitGTK. A hidden object still costs traversal, so hiding rebuilds the geometry instead.

import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { overlayMaterial } from "./overlayMaterial";
import { markOverlay } from "./overlayKinds";
import type { RebuildResult } from "../types";
import type { TangentEdges } from "../ui/renderPrefs";

export type EdgePt = [number, number, number];

/** A stable handle to one B-rep edge. Identity is meaningful: the same edge
 *  always yields the same ref for the life of the body that owns it. */
export interface EdgeRef {
  readonly id: string;
  /** owning body id, undefined only for orphan edges (see ModelView). */
  readonly body: string | undefined;
  readonly points: EdgePt[];
  /** the faces either side meet tangentially (a fillet's boundary) */
  readonly smooth: boolean;
  /** the highest fillet continuity the engine builds here, when below 3 */
  readonly reach?: number;
  /** the merged object that draws this edge, and this edge's slot in it */
  readonly draw: BodyEdges;
  readonly slot: number;
}

export const EDGE_IDLE_COLOR = 0x1b1f24;
export const EDGE_IDLE_WIDTH = 1.6;
/** A faint tangent edge is its idle colour this far toward a mid grey: lighter
 *  than that and it draws brighter than a shaded surface, which is no fainter. */
const FAINT_TOWARD = new THREE.Color(0x76808a);
const FAINT_MIX = 0.6;

export class BodyEdges {
  readonly object: LineSegments2;
  readonly material: LineMaterial;
  readonly refs: EdgeRef[] = [];

  /** per edge: display only hiding (flush seams), applied by a geometry rebuild */
  private hidden: Uint8Array;
  /** per edge: drawn faint, a tangent edge under the "faint" setting */
  private faint: Uint8Array;
  /** per edge: the colour it should currently be (survives a geometry rebuild) */
  private rgb: Float32Array;
  /** per edge: first segment in the LIVE geometry, or -1 when hidden */
  private segStart: Int32Array;
  /** per edge: how many segments it contributes (points - 1) */
  private segCount: Int32Array;
  /** the live instance colour data, held by reference (LineSegmentsGeometry
   *  .setColors does not copy a Float32Array), so a recolour writes into it. */
  private colorBuf = new Float32Array(0);
  /** segment index -> edge slot, the picking table */
  private segOwner = new Int32Array(0);
  private liveSegments = 0;
  private bodyVisible = true;
  private dirty = true;

  constructor(edges: RebuildResult["edges"], resolution: THREE.Vector2) {
    const n = edges.length;
    this.hidden = new Uint8Array(n);
    this.faint = new Uint8Array(n);
    this.rgb = new Float32Array(n * 3);
    this.segStart = new Int32Array(n);
    this.segCount = new Int32Array(n);
    const base = new THREE.Color(EDGE_IDLE_COLOR);
    for (let i = 0; i < n; i++) {
      const e = edges[i]!;
      this.refs.push({
        id: e.id,
        body: e.body,
        points: e.points,
        smooth: e.smooth === true,
        ...(e.reach !== undefined ? { reach: e.reach } : {}),
        draw: this,
        slot: i,
      });
      this.segCount[i] = Math.max(0, e.points.length - 1);
      this.rgb[i * 3] = base.r;
      this.rgb[i * 3 + 1] = base.g;
      this.rgb[i * 3 + 2] = base.b;
    }

    // One material per body, kept white: the per edge colour arrives as an instance colour multiplied by it. An outline,
    // so it stays out of what glass refracts.
    this.material = overlayMaterial(
      new LineMaterial({
        color: 0xffffff,
        vertexColors: true,
        linewidth: EDGE_IDLE_WIDTH,
        worldUnits: false,
        depthTest: true,
      }),
    );
    this.material.resolution.copy(resolution);
    this.object = new LineSegments2(new LineSegmentsGeometry(), this.material);
    this.object.name = "edges";
    this.object.userData.edges = this;
    markOverlay(this.object, "edges");
    this.flush();
  }

  /** Rebuild the drawn geometry from the currently visible edges. O(edges), and
   *  a no-op unless something changed, call it once after a BATCH of hides. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;

    let segs = 0;
    for (let i = 0; i < this.refs.length; i++) if (!this.hidden[i]) segs += this.segCount[i]!;
    this.liveSegments = segs;

    // An empty body still gets a degenerate geometry, never drawn: three's raycast and computeBoundingSphere read
    // instanceStart directly.
    const count = Math.max(segs, 1);
    const pos = new Float32Array(count * 6);
    const col = new Float32Array(count * 6);
    const owner = new Int32Array(count).fill(-1);

    let s = 0;
    for (let i = 0; i < this.refs.length; i++) {
      if (this.hidden[i]) {
        this.segStart[i] = -1;
        continue;
      }
      this.segStart[i] = s;
      const pts = this.refs[i]!.points;
      const r = this.rgb[i * 3]!,
        g = this.rgb[i * 3 + 1]!,
        b = this.rgb[i * 3 + 2]!;
      for (let k = 0; k + 1 < pts.length; k++, s++) {
        const a = pts[k]!,
          c = pts[k + 1]!;
        const o = s * 6;
        pos[o] = a[0];
        pos[o + 1] = a[1];
        pos[o + 2] = a[2];
        pos[o + 3] = c[0];
        pos[o + 4] = c[1];
        pos[o + 5] = c[2];
        col[o] = r;
        col[o + 1] = g;
        col[o + 2] = b;
        col[o + 3] = r;
        col[o + 4] = g;
        col[o + 5] = b;
        owner[s] = i;
      }
    }

    const geo = new LineSegmentsGeometry();
    geo.setPositions(pos);
    geo.setColors(col);
    this.object.geometry.dispose();
    this.object.geometry = geo;
    this.colorBuf = col;
    this.segOwner = owner;
    this.applyVisible();
  }

  /** Which edge a raycast hit belongs to. `segment` is the `faceIndex` three
   *  reports for a LineSegments2 hit, the instance (segment) index. */
  refAtSegment(segment: number): EdgeRef | undefined {
    const slot = this.segOwner[segment];
    return slot === undefined || slot < 0 ? undefined : this.refs[slot];
  }

  /** Repaint one edge. Cheap: writes its own segment span and uploads only that
   *  span, the same discipline highlight.ts uses for face vertex colours. */
  setColor(slot: number, color: THREE.Color) {
    this.rgb[slot * 3] = color.r;
    this.rgb[slot * 3 + 1] = color.g;
    this.rgb[slot * 3 + 2] = color.b;
    const start = this.segStart[slot]!;
    const n = this.segCount[slot]!;
    if (start < 0 || n === 0) return; // hidden, the colour lands on the next flush
    for (let s = start; s < start + n; s++) {
      const o = s * 6;
      this.colorBuf[o] = color.r;
      this.colorBuf[o + 1] = color.g;
      this.colorBuf[o + 2] = color.b;
      this.colorBuf[o + 3] = color.r;
      this.colorBuf[o + 4] = color.g;
      this.colorBuf[o + 5] = color.b;
    }
    const attr = this.object.geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute | undefined;
    if (attr) {
      attr.data.addUpdateRange(start * 6, n * 6);
      attr.data.needsUpdate = true;
    }
  }

  /** Repaint one edge in its IDLE colour: `base`, or lighter for a faint
   *  tangent edge. Hover, selection and error paint through setColor instead. */
  setIdleColor(slot: number, base: THREE.Color) {
    this.setColor(slot, this.faint[slot] ? faded(base) : base);
  }

  /** How tangent edges are drawn. Takes effect on the next flush() for hiding,
   *  and on the next idle repaint for faintness. */
  setTangentEdges(mode: TangentEdges) {
    for (const ref of this.refs) {
      if (!ref.smooth) continue;
      this.setHidden(ref.slot, mode === "hide");
      this.faint[ref.slot] = mode === "faint" ? 1 : 0;
    }
  }

  /** Repaint EVERY edge in its idle colour (used when the idle base colour
   *  changes). One upload. */
  setColorAll(base: THREE.Color, skip?: (ref: EdgeRef) => boolean) {
    const light = faded(base);
    for (let i = 0; i < this.refs.length; i++) {
      if (skip?.(this.refs[i]!)) continue;
      const color = this.faint[i] ? light : base;
      this.rgb[i * 3] = color.r;
      this.rgb[i * 3 + 1] = color.g;
      this.rgb[i * 3 + 2] = color.b;
      const start = this.segStart[i]!;
      const n = this.segCount[i]!;
      if (start < 0) continue;
      for (let s = start; s < start + n; s++) {
        const o = s * 6;
        this.colorBuf[o] = color.r;
        this.colorBuf[o + 1] = color.g;
        this.colorBuf[o + 2] = color.b;
        this.colorBuf[o + 3] = color.r;
        this.colorBuf[o + 4] = color.g;
        this.colorBuf[o + 5] = color.b;
      }
    }
    const attr = this.object.geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute | undefined;
    if (attr) {
      attr.data.clearUpdateRanges(); // whole-buffer rewrite; drop queued sub-ranges
      attr.data.needsUpdate = true;
    }
  }

  /** Hide/show one edge (display only). Takes effect on the next flush(). */
  setHidden(slot: number, hidden: boolean) {
    const v = hidden ? 1 : 0;
    if (this.hidden[slot] === v) return;
    this.hidden[slot] = v;
    this.dirty = true;
  }

  isHidden(slot: number): boolean {
    return this.hidden[slot] === 1;
  }

  /** hideFlushSeams only ever hides, and a body reused across a rebuild keeps this object, so its old seam hiding would
   *  otherwise pile up. */
  showAll() {
    for (let i = 0; i < this.hidden.length; i++) {
      if (this.hidden[i]) {
        this.hidden[i] = 0;
        this.dirty = true;
      }
    }
  }

  /** Whether this body is shown at all (body hiding / isolate). */
  setBodyVisible(v: boolean) {
    this.bodyVisible = v;
    this.applyVisible();
  }

  private applyVisible() {
    this.object.visible = this.bodyVisible && this.liveSegments > 0;
  }

  /** Segments in the drawn geometry. */
  get segments(): number {
    return this.liveSegments;
  }

  /** Any edge currently drawn and pickable? (`object.visible` folds in both the
   *  body's visibility and "this body has edges left after hiding".) */
  get pickable(): boolean {
    return this.object.visible;
  }

  /** The refs a pick or a chain walk may land on, visible body, unhidden edge. */
  visibleRefs(): EdgeRef[] {
    if (!this.object.visible) return [];
    return this.refs.filter((r) => this.segStart[r.slot]! >= 0);
  }

  setResolution(res: THREE.Vector2) {
    this.material.resolution.copy(res);
  }

  /** Restore build-time appearance on a REUSED body (see resetBodyAppearance). */
  resetAppearance() {
    // The whole pose: the move ghost carries rotation and scale too (render.resetBodyAppearance).
    this.object.position.set(0, 0, 0);
    this.object.quaternion.identity();
    this.object.scale.set(1, 1, 1);
    this.material.clippingPlanes = null;
    this.material.opacity = 1;
    this.material.color.setHex(0xffffff);
    this.material.linewidth = EDGE_IDLE_WIDTH;
    this.showAll(); // seam hiding is re-derived from the new model, not inherited
    this.setColorAll(new THREE.Color(EDGE_IDLE_COLOR));
  }

  dispose() {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

function faded(base: THREE.Color): THREE.Color {
  return base.clone().lerp(FAINT_TOWARD, FAINT_MIX);
}
