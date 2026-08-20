// Making one edge unmistakable.
//
// The hover highlight was a colour swap on the edge's own instance colour:
// 0x1b1f24 to a pale amber, on a 1.6px line, drawn with a depth test against the
// surface it lies on. That is a real change and it is not enough to see. It has
// to compete with a lit face right underneath it, and against the ambiguous-edge
// menu — which by construction opens right where the edges in question are —
// there was nothing left to look at at all.
//
// So the emphasised edge is DRAWN AGAIN: one extra line, over the top, several
// times wider, with the depth test off so it cannot be swallowed by the surface
// it belongs to. Nothing about the model's own edge data changes, which is the
// point — the emphasis is a display, so it is a separate object that can be
// switched off by removing it rather than a state the edge buffers have to be
// walked back out of.
//
// ONE object, reused. Hover changes on every pointermove that crosses an edge,
// and building and disposing a Line2 per change would allocate a geometry, a
// material and their GPU buffers dozens of times a second.

import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

/** Width of the emphasis line, px. Roughly three times an idle edge — wide
 *  enough to read as "this one" at a glance without becoming a bar that hides
 *  the geometry under it. */
export const EMPHASIS_WIDTH = 4.5;

/** Over everything, including the handles: while a menu is asking which edge you
 *  meant, the answer is the most important thing on screen. */
const RENDER_ORDER = 1000;

/** Flatten a polyline into the segment-pair positions LineSegmentsGeometry
 *  wants: every interior point appears twice, once as an end and once as the
 *  next start.
 *
 *  Split out and exported because it is the part that can silently be wrong —
 *  an off-by-one here draws an edge that is subtly not the edge, which is the
 *  one thing an emphasis must never do. */
export function segmentPositions(points: readonly (readonly number[])[]): Float32Array {
  const n = Math.max(0, points.length - 1);
  const out = new Float32Array(n * 6);
  for (let k = 0; k < n; k++) {
    const a = points[k]!;
    const b = points[k + 1]!;
    const o = k * 6;
    out[o] = a[0] ?? 0; out[o + 1] = a[1] ?? 0; out[o + 2] = a[2] ?? 0;
    out[o + 3] = b[0] ?? 0; out[o + 4] = b[1] ?? 0; out[o + 5] = b[2] ?? 0;
  }
  return out;
}

/** A single reusable over-line. `show` re-points it; `hide` takes it off screen
 *  without giving up its buffers. */
export class EdgeEmphasis {
  readonly object: LineSegments2;
  private readonly material: LineMaterial;

  constructor(resolution: THREE.Vector2, color: THREE.ColorRepresentation) {
    this.material = new LineMaterial({
      color,
      linewidth: EMPHASIS_WIDTH,
      worldUnits: false,
      // The whole reason this exists as a second object: an edge lies exactly ON
      // the surface it bounds, so a depth-tested wide line z-fights with it and
      // comes out dashed. Off, it is simply drawn last and wins.
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.material.resolution.copy(resolution);
    this.object = new LineSegments2(new LineSegmentsGeometry(), this.material);
    this.object.name = "edge-emphasis";
    this.object.renderOrder = RENDER_ORDER;
    this.object.frustumCulled = false; // its geometry is rewritten in place
    this.object.visible = false;
    // Never a pick target. It sits on top of the edge it is emphasising, and a
    // raycast that found this instead would return an object with no EdgeRef
    // behind it and swallow the click.
    this.object.raycast = () => {};
  }

  setResolution(resolution: THREE.Vector2) {
    this.material.resolution.copy(resolution);
  }

  setColor(color: THREE.ColorRepresentation) {
    this.material.color.set(color);
  }

  /** Draw this polyline emphasised. A polyline with fewer than two points has
   *  no segments to draw and hides instead of producing a degenerate geometry. */
  show(points: readonly (readonly number[])[]) {
    if (points.length < 2) {
      this.hide();
      return;
    }
    const geo = new LineSegmentsGeometry();
    geo.setPositions(segmentPositions(points));
    this.object.geometry.dispose();
    this.object.geometry = geo;
    this.object.visible = true;
  }

  hide() {
    this.object.visible = false;
  }

  dispose() {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
