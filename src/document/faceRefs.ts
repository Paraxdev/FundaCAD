// Which faces a per face material is on after a rebuild. A rebuild that changes
// topology (a fillet, a slot) reorders OCCT's face list, so a stored index alone
// lands on another face. Each assignment carries a print of its face, and each
// build is matched against the one before it, with the engine selector's
// tolerances (select/tuning.rs) where they apply.
//
// The rules, per body: an unchanged etag keeps every face. Otherwise an old face
// stays on every new face that is the nearest one to some of its sample points,
// so a split face keeps its material on each part; with the face count unchanged, an unmatched face
// keeps its index if the face there looks like it; a face still unmatched takes
// the nearest new face nobody stayed on with the same kind and normal. A new face
// nothing maps to (a fillet, a slot floor) stays uncoloured, a face with no
// match is deleted and its assignment draws nothing until an undo brings it back.
// A ref the track does not hold resolves from the last place it was seen, or
// from its own print: on the faces it lies on, else by index when the face count
// and that face's look are unchanged.

import type { RebuildResult, Vec3 } from "../types";
import { faceKey, parseFaceKey } from "./faceMaterials";

export interface FacePrint {
  centroid: Vec3;
  normal: Vec3;
  area: number;
  surface: "plane" | "curved";
  /** Points inside the face, x y z flat. */
  points: number[];
  /** The body's face count. */
  faces: number;
}

export interface FaceRef {
  body: string;
  face: number;
  material: string;
  at?: FacePrint;
}

export interface BodySpan {
  id: string;
  faceStart: number;
  faceCount: number;
  etag?: string;
}

interface FaceGeom {
  print: FacePrint;
  tris: Float64Array;
  lo: Vec3;
  hi: Vec3;
}

interface BodyGeom {
  faces: FaceGeom[];
  diag: number;
  grid?: FaceGrid;
}

/** Faces by the cells of a uniform grid their boxes, padded by the position tolerance, touch. */
interface FaceGrid {
  lo: number[];
  cell: number;
  n: number;
  cells: Map<number, number[]>;
}

export interface FaceTrack {
  bodies: Map<string, { etag?: string | undefined; prints: FacePrint[] }>;
  refs: Map<string, { ref: FaceRef; faces: number[] }>;
  /** Where each ref was last found, kept while it is found nowhere. */
  seen: Map<string, { ref: FaceRef; face: number; at: FacePrint }>;
}

export interface FaceResolution {
  /** Ref id to the local faces of its body it is on now, empty when none. */
  faces: Map<string, number[]>;
  track: FaceTrack;
}

const SAMPLES = 12;
const PLANE_ANG = 1e-4;
const ANG_TOL = 0.02;
const AREA_REL = 0.05;
const MAX_CANDIDATE_TRIS = 512;
// Prints keep points to 1e-4, so a point within 1e-3 of a face is on it.
const ON2 = 1e-6;

interface ResultGeom {
  /** Triangle indices grouped by global face id, face f at start[f]..start[f + 1]. */
  order: Int32Array;
  start: Int32Array;
  bodies: Map<string, BodyGeom>;
}

const geomCache = new WeakMap<RebuildResult, ResultGeom>();

function bodyGeom(result: RebuildResult, body: BodySpan): BodyGeom {
  let r = geomCache.get(result);
  if (!r) geomCache.set(result, (r = { ...byFace(result.mesh.faceIds), bodies: new Map() }));
  let g = r.bodies.get(body.id);
  if (!g) r.bodies.set(body.id, (g = measure(result, body, r)));
  return g;
}

function byFace(F: ArrayLike<number>): { order: Int32Array; start: Int32Array } {
  let top = 0;
  for (let t = 0; t < F.length; t++) top = Math.max(top, F[t]! + 1);
  const start = new Int32Array(top + 1);
  for (let t = 0; t < F.length; t++) start[F[t]! + 1]!++;
  for (let f = 0; f < top; f++) start[f + 1]! += start[f]!;
  const fill = start.slice(0, top);
  const order = new Int32Array(F.length);
  for (let t = 0; t < F.length; t++) order[fill[F[t]!]!++] = t;
  return { order, start };
}

/** Every face of `body` in `result`, as a print. */
export function bodyPrints(result: RebuildResult, body: BodySpan): FacePrint[] {
  return bodyGeom(result, body).faces.map((f) => f.print);
}

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: ArrayLike<number>) => Math.sqrt(dot(a, a));
const round = (v: number) => Math.round(v * 1e4) / 1e4;

function measure(result: RebuildResult, body: BodySpan, r: ResultGeom): BodyGeom {
  const { positions: P, indices: I } = result.mesh;
  const lists = Array.from({ length: body.faceCount }, (_, f) => {
    const g = body.faceStart + f;
    return g + 1 < r.start.length ? r.order.subarray(r.start[g]!, r.start[g + 1]!) : new Int32Array(0);
  });
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const faces = lists.map((list): FaceGeom => {
    const tris = new Float64Array(list.length * 9);
    const flo: Vec3 = [Infinity, Infinity, Infinity];
    const fhi: Vec3 = [-Infinity, -Infinity, -Infinity];
    const c: Vec3 = [0, 0, 0];
    const n: Vec3 = [0, 0, 0];
    const units: Vec3[] = [];
    let area = 0;
    list.forEach((t, k) => {
      for (let j = 0; j < 3; j++) {
        const v = I[3 * t + j]!;
        for (let a = 0; a < 3; a++) {
          const x = P[3 * v + a]!;
          tris[9 * k + 3 * j + a] = x;
          flo[a] = Math.min(flo[a]!, x);
          fhi[a] = Math.max(fhi[a]!, x);
        }
      }
      const o = 9 * k;
      const cr = cross(sub(tris.subarray(o + 3), tris.subarray(o)), sub(tris.subarray(o + 6), tris.subarray(o)));
      const a2 = len(cr);
      area += a2 / 2;
      for (let a = 0; a < 3; a++) {
        c[a]! += (a2 / 2) * ((tris[o + a]! + tris[o + 3 + a]! + tris[o + 6 + a]!) / 3);
        n[a]! += cr[a]! / 2;
      }
      if (a2 > 0) units.push([cr[0] / a2, cr[1] / a2, cr[2] / a2]);
    });
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, flo[a]!);
      hi[a] = Math.max(hi[a]!, fhi[a]!);
    }
    const nl = len(n);
    const centroid: Vec3 =
      area > 0 ? [c[0] / area, c[1] / area, c[2] / area] : [tris[0] ?? 0, tris[1] ?? 0, tris[2] ?? 0];
    // A closed or half round face's area vectors cancel, its mean normal says nothing.
    const normal: Vec3 = nl > 0.05 * area && nl > 0 ? [n[0] / nl, n[1] / nl, n[2] / nl] : [0, 0, 0];
    const plane = len(normal) > 0 && units.every((u) => 1 - dot(u, normal) <= PLANE_ANG);
    return {
      print: {
        centroid: centroid.map(round) as Vec3,
        normal: normal.map((v) => Math.round(v * 1e6) / 1e6) as Vec3,
        area: round(area),
        surface: plane ? "plane" : "curved",
        points: sample(tris, centroid).map(round),
        faces: body.faceCount,
      },
      tris,
      lo: flo,
      hi: fhi,
    };
  });
  const diag = Number.isFinite(lo[0]) ? len(sub(hi, lo)) : 0;
  return { faces, diag };
}

/** Farthest point sampling over triangle centroids and their midpoints towards
 *  each corner, all strictly inside the face. */
function sample(tris: Float64Array, centroid: Vec3): number[] {
  const count = tris.length / 9;
  const step = Math.max(1, Math.floor(count / MAX_CANDIDATE_TRIS));
  const cand: Vec3[] = [];
  for (let k = 0; k < count; k += step) {
    const o = 9 * k;
    const m: Vec3 = [0, 1, 2].map((a) => (tris[o + a]! + tris[o + 3 + a]! + tris[o + 6 + a]!) / 3) as Vec3;
    cand.push(m);
    for (let j = 0; j < 3; j++) cand.push([0, 1, 2].map((a) => (m[a]! + tris[o + 3 * j + a]!) / 2) as Vec3);
  }
  if (!cand.length) return [];
  const near = cand.map((p) => len(sub(p, centroid)));
  let pick = near.indexOf(Math.max(...near));
  const out: number[] = [];
  const gap = cand.map(() => Infinity);
  for (let s = 0; s < SAMPLES && pick >= 0; s++) {
    const p = cand[pick]!;
    out.push(...p);
    let best = -1;
    let far = 1e-9;
    cand.forEach((q, i) => {
      gap[i] = Math.min(gap[i]!, len(sub(q, p)));
      if (gap[i]! > far) {
        far = gap[i]!;
        best = i;
      }
    });
    pick = best;
  }
  return out;
}

/** Squared distance from `p` to the triangle at `o` in `t` (Ericson, closest point on triangle). */
function triDist2(p: Vec3, t: Float64Array, o: number): number {
  const a = t.subarray(o, o + 3),
    b = t.subarray(o + 3, o + 6),
    c = t.subarray(o + 6, o + 9);
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  const at = (q: ArrayLike<number>) => {
    const d = sub(p, q);
    return dot(d, d);
  };
  const along = (s: ArrayLike<number>, e: Vec3, v: number) =>
    at([s[0]! + v * e[0], s[1]! + v * e[1], s[2]! + v * e[2]]);
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b),
    d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c),
    d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const den = 1 / (va + vb + vc);
  const v = vb * den,
    w = vc * den;
  return at([a[0]! + ab[0] * v + ac[0] * w, a[1]! + ab[1] * v + ac[1] * w, a[2]! + ab[2] * v + ac[2] * w]);
}

/** Squared distance from `p` to face `g`, Infinity past `tol` of its box. */
function dist2(p: Vec3, g: FaceGeom, tol: number): number {
  if (p.some((v, a) => v < g.lo[a]! - tol || v > g.hi[a]! + tol)) return Infinity;
  let best = Infinity;
  for (let o = 0; o < g.tris.length && best > ON2; o += 9) best = Math.min(best, triDist2(p, g.tris, o));
  return best;
}

interface Claim {
  face: number;
  /** 0 stayed put, 1 kept its index, 2 paired with a moved face. */
  rank: number;
  hits: number;
}

interface Tol {
  plane: number;
  pos: number;
}

const tolOf = (g: BodyGeom): Tol => ({ plane: 1e-3 + 1e-5 * g.diag, pos: 0.5 + 1e-3 * g.diag });

function gridOf(g: BodyGeom): FaceGrid {
  const pad = tolOf(g).pos;
  const lo = [0, 1, 2].map((a) => g.faces.reduce((m, f) => Math.min(m, f.lo[a]! - pad), Infinity));
  const hi = [0, 1, 2].map((a) => g.faces.reduce((m, f) => Math.max(m, f.hi[a]! + pad), -Infinity));
  const n = Math.max(1, Math.min(64, Math.round(2 * Math.cbrt(g.faces.length))));
  const cell = Math.max(1e-9, ...[0, 1, 2].map((a) => (hi[a]! - lo[a]!) / n));
  const grid: FaceGrid = { lo, cell, n, cells: new Map() };
  g.faces.forEach((f, face) => {
    eachCell(
      grid,
      f.lo.map((v) => v - pad),
      f.hi.map((v) => v + pad),
      (key) => {
        const list = grid.cells.get(key);
        if (list) list.push(face);
        else grid.cells.set(key, [face]);
      },
    );
  });
  return grid;
}

function eachCell(grid: FaceGrid, lo: number[], hi: number[], visit: (key: number) => void) {
  const at = (v: number, a: number) => Math.min(grid.n - 1, Math.max(0, Math.floor((v - grid.lo[a]!) / grid.cell)));
  for (let x = at(lo[0]!, 0); x <= at(hi[0]!, 0); x++) {
    for (let y = at(lo[1]!, 1); y <= at(hi[1]!, 1); y++) {
      for (let z = at(lo[2]!, 2); z <= at(hi[2]!, 2); z++) visit(x + grid.n * (y + grid.n * z));
    }
  }
}

/** The faces whose padded boxes share a grid cell with the box `lo`..`hi`, in face order. */
function nearby(g: BodyGeom, lo: number[], hi: number[]): number[] {
  if (!g.faces.length || !lo.every(Number.isFinite)) return [];
  const grid = (g.grid ??= gridOf(g));
  const out = new Set<number>();
  eachCell(grid, lo, hi, (key) => {
    for (const f of grid.cells.get(key) ?? []) out.add(f);
  });
  return [...out].sort((a, b) => a - b);
}

function stayPut(o: FacePrint, g: BodyGeom, tol: Tol): Claim[] {
  const near = o.surface === "plane" ? tol.plane : tol.pos;
  const lo = [0, 1, 2].map((a) => Math.min(...o.points.filter((_, i) => i % 3 === a)));
  const hi = [0, 1, 2].map((a) => Math.max(...o.points.filter((_, i) => i % 3 === a)));
  const cands: number[] = [];
  for (const face of nearby(g, lo, hi)) {
    const f = g.faces[face]!;
    const n = f.print;
    if (n.surface !== o.surface || [0, 1, 2].some((a) => hi[a]! < f.lo[a]! - near || lo[a]! > f.hi[a]! + near))
      continue;
    if (
      o.surface === "plane" &&
      (1 - dot(o.normal, n.normal) > PLANE_ANG || Math.abs(dot(n.normal, sub(o.centroid, n.centroid))) > tol.plane)
    )
      continue;
    cands.push(face);
  }
  // Each point counts for the nearest face only: a face narrower than the
  // tolerance would otherwise hand its material to its neighbours.
  const hits = new Map<number, number>();
  for (let i = 0; i + 2 < o.points.length; i += 3) {
    const p: Vec3 = [o.points[i]!, o.points[i + 1]!, o.points[i + 2]!];
    let best = -1;
    let bestD = near * near;
    for (const face of cands) {
      const d = dist2(p, g.faces[face]!, near);
      if (d <= bestD) {
        bestD = d;
        best = face;
      }
      if (bestD <= ON2) break;
    }
    if (best >= 0) hits.set(best, (hits.get(best) ?? 0) + 1);
  }
  const out = [...hits].sort((a, b) => a[0] - b[0]).map(([face, h]): Claim => ({ face, rank: 0, hits: h }));
  // A curved face's points near its edge can lie nearer a round cut next to it,
  // so only the faces holding a fair share of them count.
  const most = Math.max(0, ...out.map((c) => c.hits));
  return o.surface === "curved" ? out.filter((c) => 3 * c.hits >= most) : out;
}

function looksLike(o: FacePrint, n: FacePrint): boolean {
  if (o.surface !== n.surface) return false;
  return Math.abs(n.area - o.area) <= AREA_REL * Math.max(n.area, o.area) || 1 - dot(n.normal, o.normal) <= ANG_TOL;
}

function byIndex(o: FacePrint | undefined, face: number, g: BodyGeom): Claim[] {
  const n = g.faces[face]?.print;
  if (!n) return [];
  if (o && (o.faces !== g.faces.length || !looksLike(o, n))) return [];
  return [{ face, rank: 1, hits: 0 }];
}

function mapBody(old: FacePrint[], g: BodyGeom): Claim[][] {
  const tol = tolOf(g);
  const map = old.map((o) => stayPut(o, g, tol));
  const taken = new Set(map.flat().map((c) => c.face));
  if (old.length === g.faces.length) {
    old.forEach((o, i) => {
      if (map[i]!.length || taken.has(i)) return;
      const c = byIndex(o, i, g);
      if (c.length) {
        map[i] = c;
        taken.add(i);
      }
    });
  }
  old.forEach((o, i) => {
    if (map[i]!.length) return;
    let best = -1;
    let bestD = 0.5 * g.diag;
    g.faces.forEach((f, face) => {
      const n = f.print;
      if (taken.has(face) || n.surface !== o.surface) return;
      const bothAim = len(o.normal) > 0 && len(n.normal) > 0;
      if ((o.surface === "plane" || bothAim) && 1 - dot(o.normal, n.normal) > ANG_TOL) return;
      const d = len(sub(o.centroid, n.centroid));
      if (d <= bestD) {
        bestD = d;
        best = face;
      }
    });
    if (best >= 0) map[i] = [{ face: best, rank: 2, hits: 0 }];
  });
  return map;
}

/** Where each ref is on `result`, given the track the previous resolution handed back. */
export function resolveFaceRefs(
  refs: Iterable<readonly [string, FaceRef]>,
  result: RebuildResult,
  track: FaceTrack | null,
): FaceResolution {
  const spans = new Map((result.bodies ?? []).map((b) => [b.id, b]));
  const byBody = new Map<string, [string, FaceRef][]>();
  for (const [id, ref] of refs) {
    const list = byBody.get(ref.body);
    if (list) list.push([id, ref]);
    else byBody.set(ref.body, [[id, ref]]);
  }
  const faces = new Map<string, number[]>();
  const next: FaceTrack = { bodies: new Map(), refs: new Map(), seen: new Map() };
  const lastSeen = (id: string, ref: FaceRef) => {
    const s = track?.seen.get(id);
    return s?.ref === ref ? s : undefined;
  };
  for (const [bodyId, list] of byBody) {
    for (const [id, ref] of list) {
      faces.set(id, []);
      const s = lastSeen(id, ref);
      if (s) next.seen.set(id, s);
    }
    const span = spans.get(bodyId);
    if (!span) continue;
    const prev = track?.bodies.get(bodyId);
    const same = !!prev && span.etag !== undefined && prev.etag === span.etag && prev.prints.length === span.faceCount;
    let geom: BodyGeom | undefined;
    const g = () => (geom ??= bodyGeom(result, span));
    let moved: Claim[][] | undefined;
    const claims: { id: string; c: Claim }[] = [];
    for (const [id, ref] of list) {
      const was = track?.refs.get(id);
      let mine: Claim[];
      if (was && was.ref === ref && prev) {
        if (same) {
          mine = was.faces.map((face) => ({ face, rank: 0, hits: 1 }));
        } else {
          moved ??= mapBody(prev.prints, g());
          mine = was.faces.flatMap((f) => moved![f] ?? []);
        }
      } else {
        const { at, face } = lastSeen(id, ref) ?? ref;
        mine = at ? stayPut(at, g(), tolOf(g())) : [];
        if (!mine.length) mine = byIndex(at, face, g());
      }
      for (const c of mine) claims.push({ id, c });
    }
    claims.sort((a, b) => a.c.rank - b.c.rank || b.c.hits - a.c.hits);
    const owner = new Map<number, string>();
    for (const { id, c } of claims) if (!owner.has(c.face)) owner.set(c.face, id);
    for (const [face, id] of owner) faces.get(id)!.push(face);
    const prints = same ? prev!.prints : bodyPrints(result, span);
    for (const [id, ref] of list) {
      const on = faces.get(id)!.sort((a, b) => a - b);
      if (!on.length) continue;
      next.refs.set(id, { ref, faces: on });
      next.seen.set(id, {
        ref,
        face: on[0]!,
        at: { ...prints[on[0]!]!, points: on.flatMap((f) => prints[f]!.points) },
      });
    }
    next.bodies.set(bodyId, { etag: span.etag, prints });
  }
  return { faces, track: next };
}

/** The saved form: `bodyId#face` to material and to that face's print, each ref
 *  at the faces it is on now, or where it was last seen while it is on none. */
export function savedFaceRefs(
  refs: Iterable<readonly [string, FaceRef]>,
  on: FaceResolution | null,
  result: RebuildResult | null,
): { materials: Record<string, string>; prints: Record<string, FacePrint> } {
  const spans = new Map((result?.bodies ?? []).map((b) => [b.id, b]));
  const lost: [string, string, FacePrint | undefined][] = [];
  const found: [string, string, FacePrint | undefined][] = [];
  for (const [id, ref] of refs) {
    const faces = on?.faces.get(id) ?? [];
    const span = spans.get(ref.body);
    if (faces.length && span && result) {
      const prints = bodyPrints(result, span);
      for (const f of faces) found.push([faceKey(ref.body, f), ref.material, prints[f]]);
    } else {
      const s = on?.track.seen.get(id);
      const { face, at } = s?.ref === ref ? s : ref;
      lost.push([faceKey(ref.body, face), ref.material, at]);
    }
  }
  const materials: Record<string, string> = {};
  const prints: Record<string, FacePrint> = {};
  for (const [key, material, at] of [...lost, ...found]) {
    materials[key] = material;
    if (at) prints[key] = at;
    else delete prints[key];
  }
  return { materials, prints };
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

function isPrint(v: unknown): v is FacePrint {
  const p = v as Partial<FacePrint> | null;
  return (
    !!p &&
    typeof p === "object" &&
    isVec3(p.centroid) &&
    isVec3(p.normal) &&
    Number.isFinite(p.area) &&
    (p.surface === "plane" || p.surface === "curved") &&
    Array.isArray(p.points) &&
    p.points.every(Number.isFinite) &&
    Number.isSafeInteger(p.faces)
  );
}

/** The refs a saved `faceMaterials` and `facePrints` hold. A key or print that is
 *  not ours is skipped, a file from before prints gives refs without one. */
export function loadFaceRefs(materials: unknown, prints: unknown): FaceRef[] {
  const out: FaceRef[] = [];
  if (!materials || typeof materials !== "object") return out;
  const at = prints && typeof prints === "object" ? (prints as Record<string, unknown>) : {};
  for (const [key, material] of Object.entries(materials)) {
    const face = parseFaceKey(key);
    if (!face || typeof material !== "string") continue;
    const p = at[key];
    out.push(isPrint(p) ? { ...face, material, at: p } : { ...face, material });
  }
  return out;
}
