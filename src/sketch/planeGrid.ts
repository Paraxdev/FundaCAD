// The sketch grid: a lattice on the plane that follows the view and runs past every viewport edge, never fading.
// Spacing comes from niceStep at ~64px like the ground grid, and the extent is in screenfuls, not mm.

import * as THREE from "three";
import { niceStep } from "../ui/units";
import type { SketchPlane } from "./plane";

/** Target size of one minor cell on screen. Matches AdaptiveGrid. */
export const GRID_CELL_PX = 64;
/** Every Nth line is drawn brighter, the same 5 the ground grid uses, so the
 *  eye can count cells the same way in both. */
export const GRID_MAJOR_EVERY = 5;
/** Reach from the view centre as a multiple of the viewport diagonal: three times what a flat-on view needs, the
 *  margin covering an orbited plane running to the horizon and a perspective camera's wider far edge. */
export const GRID_COVER = 1.5;
/** Defensive cap per axis, about four times what GRID_COVER asks on a wide monitor at a 64px cell, so reaching it
 *  means the inputs are wrong. */
const MAX_LINES = 512;

/** Minor-line spacing in mm for the zoom, never finer than `minStep` (0 for no floor, as both callers pass). */
export function gridStep(worldPerPixel: number, minStep: number): number {
  const rough = worldPerPixel * GRID_CELL_PX;
  const nice = rough > 0 && Number.isFinite(rough) ? niceStep(rough) : 1;
  return minStep > 0 && Number.isFinite(minStep) ? Math.max(nice, minStep) : nice;
}

/** A snap lattice finer than this is smaller than a cursor can aim at, and at
 *  an extreme zoom `niceStep` will happily return one. */
export const MIN_SNAP_STEP = 0.01;

/** The lattice the cursor snaps to is the DRAWN one, the same call the drawing makes, since a visible grid is a
 *  promise about where things land. */
export function snapLatticeStep(worldPerPixel: number): number {
  const step = gridStep(worldPerPixel, 0);
  return Number.isFinite(step) && step > 0 ? Math.max(step, MIN_SNAP_STEP) : MIN_SNAP_STEP;
}

/** How far the lattice must run from the view centre, in mm, for a viewport
 *  `diagonalPx` pixels corner to corner at `worldPerPixel`. */
export function gridReach(worldPerPixel: number, diagonalPx: number): number {
  const reach = worldPerPixel * diagonalPx * GRID_COVER;
  return reach > 0 && Number.isFinite(reach) ? reach : 0;
}

export interface GridLines {
  /** x,y for every vertex, two vertices (four numbers) per line. */
  minor: number[];
  major: number[];
}

/** Lines sit at absolute multiples of `step`, keeping the majors pinned to the sketch origin however the view
 *  wanders. Each is one segment with both ends OUTSIDE the asked square, so no line end is ever visible. */
export function gridLines(cx: number, cy: number, step: number, reach: number): GridLines {
  const out: GridLines = { minor: [], major: [] };
  if (!(step > 0) || !(reach > 0) || !Number.isFinite(step) || !Number.isFinite(reach)) return out;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return out;

  const i0 = Math.floor((cx - reach) / step);
  const i1 = Math.ceil((cx + reach) / step);
  const j0 = Math.floor((cy - reach) / step);
  const j1 = Math.ceil((cy + reach) / step);
  if (i1 - i0 + 1 > MAX_LINES || j1 - j0 + 1 > MAX_LINES) return out;

  const isMajor = (i: number) => ((i % GRID_MAJOR_EVERY) + GRID_MAJOR_EVERY) % GRID_MAJOR_EVERY === 0;
  const xLo = i0 * step;
  const xHi = i1 * step;
  const yLo = j0 * step;
  const yHi = j1 * step;

  for (let i = i0; i <= i1; i++) {
    const x = i * step;
    (isMajor(i) ? out.major : out.minor).push(x, yLo, x, yHi);
  }
  for (let j = j0; j <= j1; j++) {
    const y = j * step;
    (isMajor(j) ? out.major : out.minor).push(xLo, y, xHi, y);
  }
  return out;
}

// The sketch grid's two greys, a cousin of the ground grid's.
const MINOR = 0x2c333a;
const MAJOR = 0x44505c;

/** Lift off the plane in PIXELS: a sketch on a face is coplanar with it and would z-fight; half a pixel clears the
 *  depth test without a visible gap. */
const LIFT_PX = 0.75;

/** Add `object` once and call update() freely: it rebuilds only when the lattice changes. */
export class SketchPlaneGrid {
  readonly object = new THREE.Group();
  /** current minor spacing (mm), for anyone who wants to report it */
  step = 1;

  private minorLines: THREE.LineSegments | null = null;
  private majorLines: THREE.LineSegments | null = null;
  // Additive, not a flat colour: painted lines would sit over the dimmed model as darker ghosts.
  private minorMat = new THREE.LineBasicMaterial({
    color: MINOR,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  private majorMat = new THREE.LineBasicMaterial({
    color: MAJOR,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  private key = "";
  private lift = new THREE.Vector3();

  constructor() {
    this.object.renderOrder = 1;
  }

  /** `cx`/`cy` are the camera target dropped onto the plane, `reach` comes from gridReach. True when geometry was
   *  rebuilt and a repaint is owed. */
  update(plane: SketchPlane, cx: number, cy: number, worldPerPixel: number, reach: number, minStep: number): boolean {
    const step = gridStep(worldPerPixel, minStep);
    // Quantise centre and extent onto the lattice, or every camera frame would rebuild it; GRID_COVER's slack
    // absorbs the lag.
    const qx = Math.round(cx / step) * step;
    const qy = Math.round(cy / step) * step;
    const cells = Math.ceil(reach / step);

    // The lift tracks zoom continuously, so it is a TRANSFORM, not part of the
    // key, baking it into vertices would rebuild the lattice on every scroll.
    this.lift.copy(plane.n).multiplyScalar(worldPerPixel * LIFT_PX);
    this.object.position.copy(this.lift);

    const key = `${plane.key}|${step}|${qx}|${qy}|${cells}`;
    if (key === this.key) return false;
    this.key = key;
    this.step = step;
    this.rebuild(plane, qx, qy, step, cells * step);
    return true;
  }

  setVisible(on: boolean) {
    this.object.visible = on;
  }

  dispose() {
    this.clear();
    this.minorMat.dispose();
    this.majorMat.dispose();
  }

  private clear() {
    for (const l of [this.minorLines, this.majorLines]) {
      if (!l) continue;
      this.object.remove(l);
      l.geometry.dispose();
    }
    this.minorLines = this.majorLines = null;
  }

  private rebuild(plane: SketchPlane, cx: number, cy: number, step: number, reach: number) {
    this.clear();
    const lines = gridLines(cx, cy, step, reach);
    this.minorLines = this.build(plane, lines.minor, this.minorMat);
    this.majorLines = this.build(plane, lines.major, this.majorMat);
  }

  private build(plane: SketchPlane, xy: number[], mat: THREE.Material): THREE.LineSegments | null {
    const count = xy.length / 2;
    if (count === 0) return null;
    const positions = new Float32Array(count * 3);
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      plane.to3D(xy[i * 2]!, xy[i * 2 + 1]!, p);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const seg = new THREE.LineSegments(geo, mat);
    seg.renderOrder = 1;
    // The grid is decoration; it must never take a pick or answer a raycast the
    // sketch's own geometry should have.
    seg.raycast = () => {};
    this.object.add(seg);
    return seg;
  }
}
