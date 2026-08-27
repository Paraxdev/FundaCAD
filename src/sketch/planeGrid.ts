// The grid you draw on inside a sketch: a lattice on the sketch plane that runs
// past every edge of the viewport instead of ending, or fading, anywhere you can
// see.
//
// It replaces a fixed 400mm / 80-division GridHelper whose three problems were all
// one problem — it did not know what scale you were working at.
//
//  - Spacing comes from niceStep, the same ui/units helper the world ground grid
//    uses at the same ~64px target. The two are never on screen together, but they
//    should behave identically when they swap.
//  - Floored at the SNAP step. A line you can see but cannot snap to is a lie, so
//    past that point zooming in just makes the same cells bigger.
//  - Its extent is measured in SCREENFULS, not millimetres, so "how far does it
//    reach" answers itself at every zoom.
//
// It also used to fade out with distance, on a disc pinned to the sketch origin.
// Two things were wrong with that and only one of them was the fade. The fade
// itself said the grid stops, which is the one thing a coordinate lattice must
// never say; and the disc never moved, so panning away from the origin left you
// drawing on nothing. What the fade bought was a lattice that could be small —
// nine cells — and still never show an edge. Following the VIEW instead buys the
// same thing honestly, and it is cheaper: with nothing to fade along, a grid line
// is one segment end to end rather than one per cell it crosses, and that is what
// pays for the much larger lattice.

import * as THREE from "three";
import { niceStep } from "../ui/units";
import type { SketchPlane } from "./plane";

/** Target size of one minor cell on screen. Matches AdaptiveGrid. */
export const GRID_CELL_PX = 64;
/** Every Nth line is drawn brighter — the same 5 the ground grid uses, so the
 *  eye can count cells the same way in both. */
export const GRID_MAJOR_EVERY = 5;
/** How far the lattice reaches from the view centre, as a multiple of the
 *  viewport's own diagonal.
 *
 *  Half a diagonal would exactly reach the corners of a viewport seen flat on,
 *  which is how a sketch is nearly always looked at. This is three times that,
 *  and the margin goes on the two ways it is NOT: an orbited sketch, where the
 *  far side of the plane runs off toward the horizon, and a perspective camera,
 *  where the world span at the far edge of the frame is bigger than the one
 *  measured at the target. */
export const GRID_COVER = 1.5;
/** Defensive cap on lines per axis, so a pathological step/extent can't spend a
 *  frame building a lattice nobody can see. Four times what GRID_COVER asks for
 *  on a wide monitor at a 64px cell (about 125), so reaching it means the inputs
 *  are wrong, not that somebody bought a bigger screen. */
const MAX_LINES = 512;

/** Minor-line spacing in mm for the current zoom, never finer than `minStep`
 *  (pass 0 for no floor, which is what both callers do now). */
export function gridStep(worldPerPixel: number, minStep: number): number {
  const rough = worldPerPixel * GRID_CELL_PX;
  const nice = rough > 0 && Number.isFinite(rough) ? niceStep(rough) : 1;
  return minStep > 0 && Number.isFinite(minStep) ? Math.max(nice, minStep) : nice;
}

/** A snap lattice finer than this is smaller than a cursor can aim at, and at
 *  an extreme zoom `niceStep` will happily return one. */
export const MIN_SNAP_STEP = 0.01;

/** The lattice the cursor snaps to: the one that is DRAWN, at this zoom.
 *
 *  It used to be a fixed 5mm while the drawn grid was adaptive. Zoom out and the
 *  grid drew 20mm cells while the cursor still caught on 5mm points that had no
 *  line under them; zoom in and 5mm was the finest placement available however
 *  close you got. A visible grid is a promise about where things will land, and
 *  only one number can keep it.
 *
 *  Deliberately the same call the drawing does, exported so it is one function
 *  and not two that agree today. */
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
  /** x,y for every vertex — two vertices (four numbers) per line. */
  minor: number[];
  major: number[];
}

/** The lattice covering the square of half-width `reach` around (cx, cy).
 *
 *  Lines sit at absolute multiples of `step`, not at offsets from the centre —
 *  that is what keeps the major lines pinned to the sketch origin (and to round
 *  coordinates) however far the view wanders. Each one is a single segment
 *  spanning the whole lattice, and both its ends lie OUTSIDE the square that was
 *  asked for, which is the point: a line that stops where the viewport does is a
 *  line you can see the end of.
 */
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

// The same two greys the sketch grid has always worn (and a cousin of the ground
// grid's).
const MINOR = 0x2c333a;
const MAJOR = 0x44505c;

/** How far off the plane the lattice floats, in PIXELS. A sketch on a face is
 *  coplanar with that face, and coplanar geometry z-fights; half a pixel toward
 *  the viewer wins the depth test without ever being visible as a gap. */
const LIFT_PX = 0.75;

/** The scene object, rebuilt only when the lattice it should be drawing actually
 *  changes. Add `object` to the scene once and call update() as often as you
 *  like — the key check makes a no-op update cost a handful of divisions. */
export class SketchPlaneGrid {
  readonly object = new THREE.Group();
  /** current minor spacing (mm), for anyone who wants to report it */
  step = 1;

  private minorLines: THREE.LineSegments | null = null;
  private majorLines: THREE.LineSegments | null = null;
  // Additive rather than a flat colour: a sketch dims the model behind it, and
  // painted lines would sit over the dimmed geometry as darker ghosts. Adding to
  // what is already on screen cannot darken anything.
  private minorMat = new THREE.LineBasicMaterial({
    color: MINOR, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  private majorMat = new THREE.LineBasicMaterial({
    color: MAJOR, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  private key = "";
  private lift = new THREE.Vector3();

  constructor() {
    this.object.renderOrder = 1;
  }

  /** Re-place and (when needed) rebuild. `cx`/`cy` are the lattice centre in
   *  sketch coordinates — the camera target dropped onto the plane, so the grid
   *  goes where you are looking. `reach` is how far it must run from there; see
   *  gridReach. Returns true when geometry was rebuilt, i.e. a repaint is owed. */
  update(
    plane: SketchPlane,
    cx: number,
    cy: number,
    worldPerPixel: number,
    reach: number,
    minStep: number,
  ): boolean {
    const step = gridStep(worldPerPixel, minStep);
    // Quantise both the centre and the extent onto the lattice. `reach` is a
    // continuous function of the zoom and `cx`/`cy` of the pan, so leaving
    // either raw would rebuild the whole lattice on every frame the camera
    // moves. On the lattice they change only when a cell is actually crossed,
    // and the extent has GRID_COVER's slack to spend on the lag.
    const qx = Math.round(cx / step) * step;
    const qy = Math.round(cy / step) * step;
    const cells = Math.ceil(reach / step);

    // The lift tracks zoom continuously, so it is a TRANSFORM, not part of the
    // key — baking it into vertices would rebuild the lattice on every scroll.
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
