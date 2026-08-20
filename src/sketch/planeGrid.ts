// The grid you draw on inside a sketch: a lattice on the sketch plane that fades
// out with distance instead of ending at a border.
//
// It replaces a fixed 400mm / 80-division GridHelper whose three problems were all
// one problem — it did not know what scale you were working at.
//
//  - Spacing comes from niceStep, the same ui/units helper the world ground grid
//    uses at the same ~64px target. The two are never on screen together, but they
//    should behave identically when they swap.
//  - Floored at the SNAP step. A line you can see but cannot snap to is a lie, so
//    past that point zooming in just makes the same cells bigger.
//  - The fade is baked into vertex colours with an ADDITIVE material, so shade 0 is
//    genuinely invisible. Fading to the background colour would leave dark ghost
//    lines over the dimmed model.

import * as THREE from "three";
import { niceStep } from "../ui/units";
import type { SketchPlane } from "./plane";

/** Target size of one minor cell on screen. Matches AdaptiveGrid. */
export const GRID_CELL_PX = 64;
/** How far the lattice reaches, in minor cells. About a screen's worth, so the
 *  fade completes inside the viewport and the user never meets an edge. */
export const GRID_RADIUS_CELLS = 9;
/** Every Nth line is drawn brighter — the same 5 the ground grid uses, so the
 *  eye can count cells the same way in both. */
export const GRID_MAJOR_EVERY = 5;
/** Defensive cap on lattice size, so a pathological step/radius can't spend a
 *  frame building a million segments nobody can see. */
const MAX_CELLS = 400;

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

/** Brightness at distance `d` from the fade centre: 1 at the centre, 0 at
 *  `radius` and beyond.
 *
 *  (1 − t²)² rather than a linear ramp: it leaves with zero slope at both ends,
 *  so the grid neither has a visible rim where it stops nor a bright disc where
 *  it starts. It also holds most of its brightness through the first third of
 *  the radius, which is the part you are actually drawing in. */
export function gridFalloff(d: number, radius: number): number {
  if (!(radius > 0) || !Number.isFinite(radius)) return 0;
  if (!(d >= 0) || !Number.isFinite(d)) return 0;
  const t = d / radius;
  if (t >= 1) return 0;
  const k = 1 - t * t;
  return k * k;
}

export interface GridSegments {
  /** x,y for every vertex — two vertices (four numbers) per segment, in sketch
   *  plane millimetres. */
  xy: number[];
  /** 0..1 brightness, one per VERTEX, so the fade varies ALONG each line. */
  shade: number[];
  /** one per SEGMENT: does it lie on a major lattice line? */
  major: boolean[];
}

/** The lattice around (cx, cy), as segments carrying their own fade.
 *
 *  Lines sit at absolute multiples of `step`, not at offsets from the centre —
 *  that is what keeps the major lines pinned to the sketch origin (and to
 *  round coordinates) no matter where the centre wanders. Each line is cut at
 *  every crossing so the fade can vary along it; segments that are dark at both
 *  ends are dropped, which is also what rounds the lattice off into a disc
 *  rather than a square. */
export function gridSegments(
  cx: number,
  cy: number,
  step: number,
  radius: number,
): GridSegments {
  const out: GridSegments = { xy: [], shade: [], major: [] };
  if (!(step > 0) || !(radius > 0) || !Number.isFinite(step) || !Number.isFinite(radius)) return out;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return out;
  if (radius / step > MAX_CELLS) return out;

  const i0 = Math.ceil((cx - radius) / step);
  const i1 = Math.floor((cx + radius) / step);
  const j0 = Math.ceil((cy - radius) / step);
  const j1 = Math.floor((cy + radius) / step);
  const shadeAt = (x: number, y: number) => gridFalloff(Math.hypot(x - cx, y - cy), radius);

  const push = (x1: number, y1: number, x2: number, y2: number, major: boolean) => {
    const s1 = shadeAt(x1, y1);
    const s2 = shadeAt(x2, y2);
    if (s1 <= 0 && s2 <= 0) return; // wholly outside the fade — nothing to draw
    out.xy.push(x1, y1, x2, y2);
    out.shade.push(s1, s2);
    out.major.push(major);
  };

  for (let i = i0; i <= i1; i++) {
    const x = i * step;
    const major = ((i % GRID_MAJOR_EVERY) + GRID_MAJOR_EVERY) % GRID_MAJOR_EVERY === 0;
    for (let j = j0; j < j1; j++) push(x, j * step, x, (j + 1) * step, major);
  }
  for (let j = j0; j <= j1; j++) {
    const y = j * step;
    const major = ((j % GRID_MAJOR_EVERY) + GRID_MAJOR_EVERY) % GRID_MAJOR_EVERY === 0;
    for (let i = i0; i < i1; i++) push(i * step, y, (i + 1) * step, y, major);
  }
  return out;
}

// The same two greys the sketch grid has always worn (and a cousin of the ground
// grid's), scaled by the per-vertex fade.
const MINOR = new THREE.Color(0x2c333a);
const MAJOR = new THREE.Color(0x44505c);

/** How far off the plane the lattice floats, in PIXELS. A sketch on a face is
 *  coplanar with that face, and coplanar geometry z-fights; half a pixel toward
 *  the viewer wins the depth test without ever being visible as a gap. */
const LIFT_PX = 0.75;

/** The scene object, rebuilt only when the lattice it should be drawing actually
 *  changes. Add `object` to the scene once and call update() as often as you
 *  like — the key check makes a no-op update cost three multiplications. */
export class SketchPlaneGrid {
  readonly object = new THREE.Group();
  /** current minor spacing (mm), for anyone who wants to report it */
  step = 1;

  private lines: THREE.LineSegments | null = null;
  private material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    // shade 0 == adds nothing == invisible, whatever is behind it
    blending: THREE.AdditiveBlending,
  });
  private key = "";
  private lift = new THREE.Vector3();

  constructor() {
    this.object.renderOrder = 1;
  }

  /** Re-place and (when needed) rebuild. `cx`/`cy` are the fade centre in sketch
   *  coordinates — the cursor, or the origin before the pointer has moved.
   *  Returns true when geometry was rebuilt, i.e. when a repaint is owed. */
  update(
    plane: SketchPlane,
    cx: number,
    cy: number,
    worldPerPixel: number,
    minStep: number,
  ): boolean {
    const step = gridStep(worldPerPixel, minStep);
    const radius = step * GRID_RADIUS_CELLS;
    // Quantise the fade centre onto the lattice. The fade lives in the vertex
    // colours, so an exact centre would mean rebuilding on every mouse move;
    // one minor cell of lag against a nine-cell radius is not something an eye
    // can catch, and it is the difference between a rebuild per frame and a
    // rebuild per cell crossed.
    const qx = Math.round(cx / step) * step;
    const qy = Math.round(cy / step) * step;

    // The lift tracks zoom continuously, so it is a TRANSFORM, not part of the
    // key — baking it into vertices would rebuild the lattice on every scroll.
    this.lift.copy(plane.n).multiplyScalar(worldPerPixel * LIFT_PX);
    this.object.position.copy(this.lift);

    const key = `${plane.key}|${step}|${qx}|${qy}`;
    if (key === this.key) return false;
    this.key = key;
    this.step = step;
    this.rebuild(plane, qx, qy, step, radius);
    return true;
  }

  setVisible(on: boolean) {
    this.object.visible = on;
  }

  dispose() {
    this.clear();
    this.material.dispose();
  }

  private clear() {
    if (!this.lines) return;
    this.object.remove(this.lines);
    this.lines.geometry.dispose();
    this.lines = null;
  }

  private rebuild(plane: SketchPlane, cx: number, cy: number, step: number, radius: number) {
    this.clear();
    const segs = gridSegments(cx, cy, step, radius);
    const count = segs.shade.length;
    if (count === 0) return;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const p = new THREE.Vector3();
    for (let v = 0; v < count; v++) {
      plane.to3D(segs.xy[v * 2]!, segs.xy[v * 2 + 1]!, p);
      positions[v * 3] = p.x;
      positions[v * 3 + 1] = p.y;
      positions[v * 3 + 2] = p.z;
      const base = segs.major[v >> 1] ? MAJOR : MINOR;
      const s = segs.shade[v]!;
      colors[v * 3] = base.r * s;
      colors[v * 3 + 1] = base.g * s;
      colors[v * 3 + 2] = base.b * s;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.lines = new THREE.LineSegments(geo, this.material);
    this.lines.renderOrder = 1;
    // The grid is decoration; it must never take a pick or answer a raycast the
    // sketch's own geometry should have.
    this.lines.raycast = () => {};
    this.object.add(this.lines);
  }
}
