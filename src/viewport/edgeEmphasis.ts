// The emphasised edge is drawn again as one wide line with the depth test off, so a lit face or the ambiguous edge
// menu cannot swallow it. One object is reused, since hover changes on every pointermove.

import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

/** Px, about three times an idle edge. */
export const EMPHASIS_WIDTH = 4.5;

/** Over everything, including the handles: while a menu is asking which edge you
 *  meant, the answer is the most important thing on screen. */
const RENDER_ORDER = 1000;

/** Every interior point appears twice, as an end and as the next start. Exported for tests: an off by one here draws
 *  an edge that is subtly not the edge. */
export function segmentPositions(points: readonly (readonly number[])[]): Float32Array {
  const n = Math.max(0, points.length - 1);
  const out = new Float32Array(n * 6);
  for (let k = 0; k < n; k++) {
    const a = points[k]!;
    const b = points[k + 1]!;
    const o = k * 6;
    out[o] = a[0] ?? 0;
    out[o + 1] = a[1] ?? 0;
    out[o + 2] = a[2] ?? 0;
    out[o + 3] = b[0] ?? 0;
    out[o + 4] = b[1] ?? 0;
    out[o + 5] = b[2] ?? 0;
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
      // An edge lies exactly on its surface, so a depth tested wide line z-fights with it and comes out dashed.
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
    // Never a pick target: a raycast hitting this would find no EdgeRef and swallow the click.
    this.object.raycast = () => {};
  }

  setResolution(resolution: THREE.Vector2) {
    this.material.resolution.copy(resolution);
  }

  setColor(color: THREE.ColorRepresentation) {
    this.material.color.set(color);
  }

  /** Fewer than two points hides instead of building a degenerate geometry. */
  show(points: readonly (readonly number[])[]) {
    this.showAll([points]);
  }

  /** Several polylines emphasised at once, a whole loop of edges. */
  showAll(polylines: readonly (readonly (readonly number[])[])[]) {
    const parts = polylines.filter((p) => p.length >= 2).map(segmentPositions);
    if (!parts.length) {
      this.hide();
      return;
    }
    const flat = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      flat.set(p, o);
      o += p.length;
    }
    const geo = new LineSegmentsGeometry();
    geo.setPositions(flat);
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
