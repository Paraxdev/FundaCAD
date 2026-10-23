// Closed-region (profile) detection from resolved sketch entities, each region a 2D loop for shading, hit-testing and
// the extrude preview.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import { arcPolyline } from "./arc";
import { splinePolyline } from "./spline";
import { bsplinePolyline } from "./bspline";

export interface Region {
  sketchId: string;
  loop: THREE.Vector2[]; // outer boundary, closed polygon (no repeated last point)
  holes: THREE.Vector2[][]; // inner boundaries (directly-nested loops) cut out of the material
  centroid: THREE.Vector2; // outer-loop centroid (label placement; may sit in a hole)
  interior: THREE.Vector2; // a point inside the material (outside all holes), selection anchor
  /** A sketch on a face that runs off its edge splits into regions: on-face can cut or add flush, overhang can only
   *  add. null means not asked (datum plane, no face behind), never read it as overhang. */
  support?: "on-face" | "overhang" | null;
}

const EPS = 1e-4;
const CIRCLE_SEGS = 64;
const ARC_SEGS = 48;
const SPLINE_SEGS = 16;
const v = (x: number, y: number) => new THREE.Vector2(x, y);

function closed(pts: THREE.Vector2[]): THREE.Vector2[] {
  const first = pts[0];
  return first ? [...pts, first] : pts;
}

/** One consistent sampling for every consumer (render, trace, pick, intersect), closed primitives include the
 *  closing vertex. The one place an entity becomes points, consumers must not re-tessellate. */
export function entityPolyline(e: ResolvedEntity): THREE.Vector2[] {
  switch (e.type) {
    case "line":
      return [v(e.x1, e.y1), v(e.x2, e.y2)];
    case "rectangle":
      return closed(rectCorners(e.x, e.y, e.width, e.height, e.angle));
    case "circle":
      return closed(circleLoop(e.x, e.y, e.radius));
    case "arc":
      return arcPolyline(v(e.x1, e.y1), v(e.x2, e.y2), v(e.mx, e.my), ARC_SEGS);
    case "spline":
      return splinePolyline(e.points, SPLINE_SEGS);
    case "bspline":
      return bsplinePolyline(e, SPLINE_SEGS).map((p) => v(p.x, p.y));
    case "point":
      return [v(e.x, e.y)]; // a point has no extent: a single vertex, no segments
    case "polygon":
      // e.angle is in degrees like every angle field, polygonPoints takes radians.
      return closed(polygonPoints(e.x, e.y, e.radius, e.sides, (e.angle * Math.PI) / 180));
    case "slot":
      return closed(slotOutline(e.x1, e.y1, e.x2, e.y2, e.width));
    case "text":
      return []; // text is rendered from cached glyph contours, not this single-polyline path
    case "projected":
      // the cached curve is already plain numbers, sample like the native kinds
      switch (e.curve.kind) {
        case "line":
          return [v(e.curve.x1, e.curve.y1), v(e.curve.x2, e.curve.y2)];
        case "circle":
          return closed(circleLoop(e.curve.x, e.curve.y, e.curve.r));
        case "arc":
          return arcPolyline(v(e.curve.x1, e.curve.y1), v(e.curve.x2, e.curve.y2), v(e.curve.mx, e.curve.my), ARC_SEGS);
        case "poly":
          return e.curve.pts.map(([x, y]) => v(x, y));
      }
  }
}

export function entitySegments(e: ResolvedEntity): [THREE.Vector2, THREE.Vector2][] {
  const p = entityPolyline(e);
  const out: [THREE.Vector2, THREE.Vector2][] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i],
      b = p[i + 1];
    if (a && b) out.push([a, b]);
  }
  return out;
}

/** CCW: bl, br, tr, tl, no repeat. `angleDeg` rotates about the centre. */
export function rectCorners(x: number, y: number, width: number, height: number, angleDeg = 0): THREE.Vector2[] {
  const hw = width / 2;
  const hh = height / 2;
  const local: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  // Rotation lives here, not at nine call sites. Angle 0 must stay bit-identical to the unrotated points, every saved
  // axis-aligned rectangle depends on it.
  if (!angleDeg) return local.map(([lx, ly]) => new THREE.Vector2(x + lx, y + ly));
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return local.map(([lx, ly]) => new THREE.Vector2(x + lx * c - ly * s, y + lx * s + ly * c));
}

/** Structural: the solver reads points back from planegcs as plain {x, y}, and a Vector2 is one. */
export interface Pt2 {
  x: number;
  y: number;
}

export interface RectDef {
  x: number;
  y: number;
  width: number;
  height: number;
  /** degrees about its own centre, 0 for an axis-aligned one */
  angle: number;
}

/** `a` to `b` is one full edge and `c` sets the opposite edge's distance, the inverse of rectCorners. Keeps one rotated
 *  rectangle (W/H dims, edge addressing) instead of four lines. `c` is measured perpendicular to a→b so the shape does
 *  not slide, and keeps its side. Null when a = b or c lies on a→b. */
export function rectFromThreePoints(a: Pt2, b: Pt2, c: Pt2): RectDef | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const width = Math.hypot(dx, dy);
  if (!(width > EPS)) return null;
  // the edge's own unit frame: u along a→b, n its left-hand normal
  const ux = dx / width;
  const uy = dy / width;
  const signedHeight = (c.x - a.x) * -uy + (c.y - a.y) * ux;
  if (!(Math.abs(signedHeight) > EPS)) return null;
  return {
    // The centre is half a height off the MIDPOINT of a→b, on c's side.
    x: (a.x + b.x) / 2 + -uy * (signedHeight / 2),
    y: (a.y + b.y) / 2 + ux * (signedHeight / 2),
    width,
    height: Math.abs(signedHeight),
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}

export function circleLoop(cx: number, cy: number, r: number, segs = CIRCLE_SEGS): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    out.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}

/** r is the circumradius, angle the first vertex's in radians */
export function polygonPoints(cx: number, cy: number, r: number, sides: number, angle: number): THREE.Vector2[] {
  const n = Math.max(3, Math.round(sides));
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = angle + (i / n) * Math.PI * 2;
    out.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}

/** Center-to-center slot: arc centers (x1,y1) and (x2,y2), overall width w. */
export function slotOutline(x1: number, y1: number, x2: number, y2: number, w: number, segs = 16): THREE.Vector2[] {
  const r = w / 2;
  let dx = x2 - x1,
    dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const ap = Math.atan2(dx, -dy); // angle of the left perpendicular (-dy, dx)
  const P = (cx: number, cy: number, a: number) => new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  const out: THREE.Vector2[] = [P(x1, y1, ap)]; // A + perp
  for (let i = 1; i <= segs; i++) out.push(P(x2, y2, ap - (i / segs) * Math.PI)); // B cap → B − perp
  for (let i = 0; i < segs; i++) out.push(P(x1, y1, ap + Math.PI - (i / segs) * Math.PI)); // A cap → toward A + perp
  return out;
}

/** Three distinct vertices plus the repeat at minimum, or a zero-length line would read as a loop. */
function isClosedPolyline(pts: readonly THREE.Vector2[]): boolean {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last || pts.length < 4) return false;
  return Math.abs(first.x - last.x) <= EPS && Math.abs(first.y - last.y) <= EPS;
}

export function detectRegions(
  sketchId: string,
  allEntities: ResolvedEntity[],
  /** The engine's profile cut lines in sketch mm, closed or not. Omit on a datum plane. */
  footprint?: THREE.Vector2[][],
): Region[] {
  const perEntity = profileEntities(allEntities);

  // Do two curves cross at an interior point? Then shared-endpoint detection would miss a sub-region or emit a phantom
  // (an X in a square), so planarize.
  let loops: THREE.Vector2[][];
  if (anyCrossing(perEntity)) {
    // A line crossing a profile carves separately selectable sub-areas, mirroring the engine's OCCT arrangement
    // (builder.py _subdivide_faces).
    loops = traceLoops(planarize(perEntity));
  } else {
    // Fast path: a closed polyline is a loop by itself, the rest chains by shared endpoints. Asking the polyline rather
    // than naming types keeps slots and polygons, which have no free endpoints for the chain tracer.
    loops = [];
    const free: Seg[] = [];
    for (const { pts, segs } of perEntity) {
      if (isClosedPolyline(pts))
        loops.push(pts.slice(0, -1)); // drop the repeat
      else free.push(...segs);
    }
    loops.push(...traceLoops(free));
  }

  // A sketch on a face is also bounded by where the model under it starts and stops, the cut the engine makes, so an
  // area shown is an area that builds.
  let supportLoops: THREE.Vector2[][] | undefined;
  if (footprint && footprint.length) {
    const split = splitByFootprint(perEntity, loops, footprint);
    if (split) loops = split;
    supportLoops = chainLoops(footprint);
  }

  // Directly nested loops become holes, so two concentric circles yield a ring AND a disk.
  return nestLoops(sketchId, loops, supportLoops);
}

/** null when there is none. The box the engine's cut lines have to cover. */
export function profileBounds(allEntities: ResolvedEntity[]): Box | null {
  const boxes = profileEntities(allEntities)
    .map((p) => p.box)
    .filter((b) => b.minx <= b.maxx);
  if (!boxes.length) return null;
  return {
    minx: Math.min(...boxes.map((b) => b.minx)),
    miny: Math.min(...boxes.map((b) => b.miny)),
    maxx: Math.max(...boxes.map((b) => b.maxx)),
    maxy: Math.max(...boxes.map((b) => b.maxy)),
  };
}

// Sampled once here so what is picked is what is drawn. Construction geometry and text glyphs never form a profile.
function profileEntities(allEntities: ResolvedEntity[]) {
  return allEntities
    .filter((e) => !e.construction && e.type !== "text")
    .map((e) => {
      const pts = entityPolyline(e);
      const segs: Seg[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i],
          b = pts[i + 1];
        if (a && b) segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      return { e, pts, segs, box: segsBBox(segs) };
    });
}

/** parent(i) is the smallest-area loop containing i. Uses a guaranteed-interior point, a non-convex cell's centroid
 *  can lie outside it and nest under the wrong parent. */
function nestLoops(sketchId: string, loops: THREE.Vector2[][], footprint?: THREE.Vector2[][]): Region[] {
  const parent = loopParents(loops);
  const regions: Region[] = [];
  for (let i = 0; i < loops.length; i++) {
    const loop = loops[i];
    if (!loop) continue;
    const holes = loops.filter((_, j) => parent[j] === i);
    const r = mkRegion(sketchId, loop, holes);
    r.support = footprint && footprint.length ? (pointInLoops(r.interior, footprint) ? "on-face" : "overhang") : null;
    regions.push(r);
  }
  return regions;
}

/** parent(i) = the smallest-area loop that contains loop i, -1 for none. */
function loopParents(loops: THREE.Vector2[][]): number[] {
  const areas = loops.map(loopAbsArea);
  const reps = loops.map(loopInteriorPoint);
  return loops.map((_loopI, i) => {
    const p = reps[i];
    const ai = areas[i];
    if (!p || ai === undefined) return -1;
    let best = -1;
    let bestArea = Infinity;
    for (let j = 0; j < loops.length; j++) {
      const aj = areas[j];
      const lj = loops[j];
      if (j === i || aj === undefined || lj === undefined || aj <= ai) continue;
      if (pointInLoop(p, lj) && aj < bestArea) {
        bestArea = aj;
        best = j;
      }
    }
    return best;
  });
}

/** Also chains the model's B-rep boundary edges into footprint loops, so footprint and profile follow one rule. */
export function chainLoops(polylines: readonly (readonly THREE.Vector2[])[]): THREE.Vector2[][] {
  const segs: Seg[] = [];
  for (const p of polylines) {
    for (let i = 0; i + 1 < p.length; i++) {
      const a = p[i];
      const b = p[i + 1];
      if (a && b) segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }
  return traceLoops(segs);
}

/** Even-odd, so a point in a washer face's bore reads as outside: nothing under it to extrude against. */
export function pointInLoops(p: THREE.Vector2, loops: THREE.Vector2[][]): boolean {
  let inside = false;
  for (const loop of loops) if (pointInLoop(p, loop)) inside = !inside;
  return inside;
}

/** Re-cut the sketch's cells along the cut lines and keep its own material. Only segments reaching the sketch's box
 *  count, so lines need not be closed. The arrangement also makes model-face cells (face minus profile), so a cell
 *  survives only if a point of its material lies inside the sketch's original loops. */
function splitByFootprint(
  perEntity: EntSegs[],
  sketchLoops: THREE.Vector2[][],
  cuts: THREE.Vector2[][],
): THREE.Vector2[][] | null {
  if (!perEntity.length || !sketchLoops.length) return null;
  const reach: Box = {
    minx: Math.min(...perEntity.map((p) => p.box.minx)),
    miny: Math.min(...perEntity.map((p) => p.box.miny)),
    maxx: Math.max(...perEntity.map((p) => p.box.maxx)),
    maxy: Math.max(...perEntity.map((p) => p.box.maxy)),
  };
  const cutGroups: EntSegs[] = [];
  for (const line of cuts) {
    const segs: Seg[] = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i],
        b = line[i + 1];
      if (!a || !b) continue;
      const s = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      if (boxesOverlap(segsBBox([s]), reach)) segs.push(s);
    }
    if (segs.length) cutGroups.push({ segs, box: segsBBox(segs) });
  }
  if (!cutGroups.length) return null;

  const cells = traceLoops(planarize([...perEntity, ...cutGroups]));
  const parent = loopParents(cells);
  const kept = cells.filter((cell, i) => {
    const holes = cells.filter((_, j) => parent[j] === i);
    const p = materialPoint(cell, holes);
    return !!p && sketchLoops.some((l) => pointInLoop(p, l));
  });
  // Fewer cells than the sketch had alone means material was lost, and dropping a profile is worse than not splitting.
  return kept.length >= sketchLoops.length ? kept : null;
}

function mkRegion(sketchId: string, loop: THREE.Vector2[], holes: THREE.Vector2[][]): Region {
  const centroid = centroidOf(loop);
  return { sketchId, loop, holes, centroid, interior: interiorPoint(loop, holes, centroid) };
}

/** Text skips the arrangement: glyph faces (sketch-2D mm) arrive pre-formed from the engine's font tessellation, each
 *  its own extrudable profile. */
export function glyphRegion(sketchId: string, outer: [number, number][], holes: [number, number][][]): Region {
  const loop = outer.map(([x, y]) => new THREE.Vector2(x, y));
  const holeLoops = holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
  return mkRegion(sketchId, loop, holeLoops);
}

function centroidOf(loop: THREE.Vector2[]): THREE.Vector2 {
  const c = new THREE.Vector2();
  for (const p of loop) c.add(p);
  return c.divideScalar(loop.length || 1);
}

/** Filled when the anchor lies inside an odd number of the regions' outer loops, its own included. */
export function evenOddFilled(regions: readonly Region[]): boolean[] {
  return regions.map((r) => regions.filter((o) => pointInLoop(r.interior, o.loop)).length % 2 === 1);
}

export function pointInLoop(p: THREE.Vector2, loop: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (!a || !b) continue;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInRegion(p: THREE.Vector2, region: Region): boolean {
  if (!pointInLoop(p, region.loop)) return false;
  return !region.holes.some((h) => pointInLoop(p, h));
}

export function regionArea(region: Region): number {
  return region.holes.reduce((a, h) => a - loopAbsArea(h), loopAbsArea(region.loop));
}

function loopAbsArea(loop: THREE.Vector2[]): number {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const pi = loop[i],
      pj = loop[j];
    if (!pi || !pj) continue;
    a += (pj.x + pi.x) * (pj.y - pi.y);
  }
  return Math.abs(a) / 2;
}

/** Ignores holes. A non-convex cell's centroid can fall outside, so sample from the centroid toward each vertex. */
function loopInteriorPoint(loop: THREE.Vector2[]): THREE.Vector2 {
  const c = centroidOf(loop);
  if (pointInLoop(c, loop)) return c;
  for (const t of [0.5, 0.6, 0.75, 0.9]) {
    for (const vtx of loop) {
      const p = new THREE.Vector2(c.x + (vtx.x - c.x) * t, c.y + (vtx.y - c.y) * t);
      if (pointInLoop(p, loop)) return p;
    }
  }
  return c; // best effort
}

/** The parametric selection anchor. A ring's centroid sits in the hole, so sample toward each vertex. */
function interiorPoint(loop: THREE.Vector2[], holes: THREE.Vector2[][], centroid: THREE.Vector2): THREE.Vector2 {
  const ok = (p: THREE.Vector2) => pointInLoop(p, loop) && !holes.some((h) => pointInLoop(p, h));
  if (ok(centroid)) return centroid;
  for (const t of [0.9, 0.75, 0.6, 0.5]) {
    for (const vtx of loop) {
      const p = new THREE.Vector2(centroid.x + (vtx.x - centroid.x) * t, centroid.y + (vtx.y - centroid.y) * t);
      if (ok(p)) return p;
    }
  }
  // Samples toward the vertices miss a thin ring (inner_r/outer_r > 0.9) and the centroid lands in the hole, which
  // selected the inner disk. Scanline midpoints between crossings outside every hole are in the material, tried at
  // several heights.
  let minY = Infinity,
    maxY = -Infinity;
  for (const p of loop) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const rings = [loop, ...holes];
  for (const frac of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) {
    const y = minY + (maxY - minY) * frac;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i],
          b = ring[j];
        if (!a || !b) continue;
        if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k++) {
      const xk = xs[k],
        xk1 = xs[k + 1];
      if (xk === undefined || xk1 === undefined) continue;
      const p = new THREE.Vector2((xk + xk1) / 2, y);
      if (ok(p)) return p;
    }
  }
  return centroid; // best effort
}

/** Unlike interiorPoint it never guesses, a wrong answer would keep or drop a whole cell. */
function materialPoint(loop: THREE.Vector2[], holes: THREE.Vector2[][]): THREE.Vector2 | null {
  const ok = (p: THREE.Vector2) => pointInLoop(p, loop) && !holes.some((h) => pointInLoop(p, h));
  let minY = Infinity,
    maxY = -Infinity;
  for (const p of loop) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const rings = [loop, ...holes];
  let best: THREE.Vector2 | null = null;
  let bestGap = 0;
  for (let k = 1; k < 16; k++) {
    const y = minY + ((maxY - minY) * k) / 16;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i],
          b = ring[j];
        if (!a || !b) continue;
        if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
      }
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i++) {
      const x0 = xs[i]!,
        x1 = xs[i + 1]!;
      const p = new THREE.Vector2((x0 + x1) / 2, y);
      if (x1 - x0 > bestGap && ok(p)) {
        best = p;
        bestGap = x1 - x0;
      }
    }
  }
  return best;
}

type Seg = { x1: number; y1: number; x2: number; y2: number };
export type Box = { minx: number; miny: number; maxx: number; maxy: number };

function segsBBox(segs: Seg[]): Box {
  let minx = Infinity,
    miny = Infinity,
    maxx = -Infinity,
    maxy = -Infinity;
  for (const s of segs) {
    minx = Math.min(minx, s.x1, s.x2);
    miny = Math.min(miny, s.y1, s.y2);
    maxx = Math.max(maxx, s.x1, s.x2);
    maxy = Math.max(maxy, s.y1, s.y2);
  }
  return { minx, miny, maxx, maxy };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.minx <= b.maxx + EPS && b.minx <= a.maxx + EPS && a.miny <= b.maxy + EPS && b.miny <= a.maxy + EPS;
}

/** Strictly inside both spans, not a shared endpoint and not parallel: what the vertex-only tracer cannot see. */
function segCross(a: Seg, b: Seg): THREE.Vector2 | null {
  const rx = a.x2 - a.x1,
    ry = a.y2 - a.y1;
  const sx = b.x2 - b.x1,
    sy = b.y2 - b.y1;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel / collinear
  const qpx = b.x1 - a.x1,
    qpy = b.y1 - a.y1;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  const E = 1e-6;
  if (t <= E || t >= 1 - E || u <= E || u >= 1 - E) return null; // interior of BOTH only
  return v(a.x1 + t * rx, a.y1 + t * ry);
}

/** T-junction test, t in (E, 1-E): a vertex on another entity's edge interior. OCCT splits there, so we must too or
 *  the frontend region and the engine cell disagree. */
function pointOnSegInterior(px: number, py: number, s: Seg): number | null {
  const rx = s.x2 - s.x1,
    ry = s.y2 - s.y1;
  const len2 = rx * rx + ry * ry;
  if (len2 < 1e-18) return null;
  const t = ((px - s.x1) * rx + (py - s.y1) * ry) / len2;
  const E = 1e-6;
  if (t <= E || t >= 1 - E) return null;
  const dx = px - (s.x1 + t * rx),
    dy = py - (s.y1 + t * ry); // offset from the line
  return dx * dx + dy * dy > EPS * EPS ? null : t;
}

type EntSegs = { segs: Seg[]; box: Box };

/** An X crossing or T touch? The entity-bbox broad phase keeps separated entities out of the O(segs²) test. */
function anyCrossing(per: EntSegs[]): boolean {
  for (let i = 0; i < per.length; i++) {
    const pi = per[i];
    if (!pi) continue;
    for (let j = i + 1; j < per.length; j++) {
      const pj = per[j];
      if (!pj || !boxesOverlap(pi.box, pj.box)) continue;
      for (const a of pi.segs)
        for (const b of pj.segs) {
          if (segCross(a, b)) return true;
          if (pointOnSegInterior(b.x1, b.y1, a) !== null) return true;
          if (pointOnSegInterior(b.x2, b.y2, a) !== null) return true;
          if (pointOnSegInterior(a.x1, a.y1, b) !== null) return true;
          if (pointOnSegInterior(a.x2, a.y2, b) !== null) return true;
        }
    }
  }
  return false;
}

/** Split at interior intersections and at other entities' vertices on the interior, so the half-edge tracer can
 *  split there. Same broad phase as anyCrossing. */
function planarize(per: EntSegs[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < per.length; i++) {
    const pi = per[i];
    if (!pi) continue;
    for (const a of pi.segs) {
      const rx = a.x2 - a.x1,
        ry = a.y2 - a.y1;
      const len2 = rx * rx + ry * ry;
      const cuts: { x: number; y: number; t: number }[] = [];
      const addCut = (x: number, y: number) => cuts.push({ x, y, t: ((x - a.x1) * rx + (y - a.y1) * ry) / len2 });
      for (let j = 0; j < per.length; j++) {
        const pj = per[j];
        if (j === i || !pj || !boxesOverlap(pi.box, pj.box)) continue;
        for (const b of pj.segs) {
          const p = segCross(a, b);
          if (p) addCut(p.x, p.y);
          if (pointOnSegInterior(b.x1, b.y1, a) !== null) addCut(b.x1, b.y1);
          if (pointOnSegInterior(b.x2, b.y2, a) !== null) addCut(b.x2, b.y2);
        }
      }
      if (!cuts.length) {
        out.push(a);
        continue;
      }
      cuts.sort((p, q) => p.t - q.t);
      let px = a.x1,
        py = a.y1;
      for (const c of cuts) {
        if (Math.abs(c.x - px) > EPS || Math.abs(c.y - py) > EPS) out.push({ x1: px, y1: py, x2: c.x, y2: c.y });
        px = c.x;
        py = c.y;
      }
      if (Math.abs(a.x2 - px) > EPS || Math.abs(a.y2 - py) > EPS) out.push({ x1: px, y1: py, x2: a.x2, y2: a.y2 });
    }
  }
  return out;
}

function traceLoops(segs: Seg[]): THREE.Vector2[][] {
  if (segs.length < 3) return [];
  const key = (x: number, y: number) => `${Math.round(x / EPS)},${Math.round(y / EPS)}`;

  // Minimal faces via half-edge traversal handle junctions (degree > 2), touching profiles and T-joins, where simple
  // cycle tracing voids the whole component.
  const nodes = new Map<string, THREE.Vector2>();
  const nodeKey = (x: number, y: number) => {
    const k = key(x, y);
    if (!nodes.has(k)) nodes.set(k, new THREE.Vector2(x, y));
    return k;
  };
  // Half-edges pushed as adjacent pairs so the twin of i is i ^ 1, shared edges deduped.
  const he: { from: string; to: string; angle: number }[] = [];
  const seen = new Set<string>();
  for (const s of segs) {
    const a = nodeKey(s.x1, s.y1),
      b = nodeKey(s.x2, s.y2);
    if (a === b) continue;
    const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(ek)) continue;
    seen.add(ek);
    const pa = nodes.get(a)!,
      pb = nodes.get(b)!;
    he.push({ from: a, to: b, angle: Math.atan2(pb.y - pa.y, pb.x - pa.x) });
    he.push({ from: b, to: a, angle: Math.atan2(pa.y - pb.y, pa.x - pb.x) });
  }
  if (he.length < 6) return [];

  // outgoing half-edge indices per node, sorted CCW by angle
  const out = new Map<string, number[]>();
  he.forEach((h, i) => (out.get(h.from) ?? out.set(h.from, []).get(h.from)!).push(i));
  for (const idxs of out.values()) idxs.sort((i, j) => (he[i]?.angle ?? 0) - (he[j]?.angle ?? 0));
  // next half-edge in the same minimal face = the edge just clockwise of this edge's twin
  const next = (i: number): number | undefined => {
    const h = he[i];
    if (!h) return undefined;
    const idxs = out.get(h.to);
    if (!idxs) return undefined;
    const pos = idxs.indexOf(i ^ 1); // twin
    return idxs[(pos - 1 + idxs.length) % idxs.length];
  };

  const visited = new Set<number>();
  const loops: THREE.Vector2[][] = [];
  for (let s = 0; s < he.length; s++) {
    if (visited.has(s)) continue;
    const faceHE: number[] = [];
    let cur: number | undefined = s;
    let guard = 0;
    while (cur !== undefined && !visited.has(cur) && guard++ < he.length + 2) {
      visited.add(cur);
      faceHE.push(cur);
      cur = next(cur);
    }
    if (cur !== s || faceHE.length < 3) continue;
    const pts: THREE.Vector2[] = [];
    for (const hi of faceHE) {
      const h = he[hi];
      if (h) pts.push(nodes.get(h.from)!);
    }
    // keep CCW (interior) faces; the outer/unbounded face is CW (negative area)
    if (signedLoopArea(pts) > EPS) loops.push(pts);
  }
  return loops;
}

function signedLoopArea(loop: THREE.Vector2[]): number {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const pi = loop[i],
      pj = loop[j];
    if (!pi || !pj) continue;
    a += pj.x * pi.y - pi.x * pj.y;
  }
  return a / 2;
}
