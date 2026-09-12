// Where an emissive body or face puts its light, and how bright that light is.
//
// A glowing surface is lit as what it is, an AREA: each flat patch of it becomes
// a rectangle light fitted to the patch (THREE.RectAreaLight), so a lit panel
// throws the long soft pool a panel throws and a thin strip a thin one, where a
// point light at its centre put a round hotspot on the wall beside it. A curved
// face or a whole glowing body is a MESH light: its triangles are split into
// patches by which way they face, one rectangle per patch, so a tube lights its
// sides and a globe lights all round.
//
// Pure numbers, kept out of viewport.ts so they can be tested without a scene.
// The viewport owns the lights, the rank and cap budget and the shadows.

export type Vec3 = [number, number, number];

/** Surface luminance per unit of glow. A rectangle light's brightness IS a
 *  luminance, so a bigger glowing face gives off more light in total and a
 *  small one less, the way real emitters do; one number serves every size.
 *  Measured in the app (bloom off, default studio) to put a clear pool on the
 *  surface beside a lit panel without blowing out the panel's neighbours. */
export const EMITTER_LUMINANCE = 40;

/** Triangles within this angle of their patch's mean normal still count as one
 *  flat patch. Loose enough for a tessellated gentle curve, tight enough that a
 *  box's faces never merge. */
const FLAT_COS = Math.cos((12 * Math.PI) / 180);

/** A body with more glowing patches than this (an imported mesh is one face per
 *  triangle) is regrouped by facing direction only, so it costs a handful of
 *  lights rather than thousands. */
export const MAX_PATCHES_PER_BODY = 12;

/** How far the shadow for a patch is cast from in front of it. On the surface
 *  itself the patch's own triangles sat on the shadow camera's near plane. */
export function emitterStandoff(size: number): number {
  return Math.max(size * 0.05, 0.25);
}

export function emitterShadowNear(size: number): number {
  return Math.max(size * 0.1, 0.5);
}

export interface AreaEmitter {
  /** Stable within a body: a face id, or a face id and a facing direction. */
  key: string;
  /** Centre of the fitted rectangle, on the patch's outermost plane. */
  center: Vec3;
  /** Unit normal the patch emits along. */
  normal: Vec3;
  /** Unit direction of the rectangle's width, perpendicular to `normal`. */
  xAxis: Vec3;
  width: number;
  height: number;
  /** The patch's real surface area, which the rectangle only bounds. */
  area: number;
  /** Area of each face in the patch, so the caller can weight glow and colour. */
  faces: Map<number, number>;
  /** Longest extent of the patch, what the shadow camera is sized from. */
  size: number;
}

/** The dominant axis of a normal, 0..5 for +x, -x, +y, -y, +z, -z. */
function facing(nx: number, ny: number, nz: number): number {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ax >= ay && ax >= az) return nx >= 0 ? 0 : 1;
  if (ay >= az) return ny >= 0 ? 2 : 3;
  return nz >= 0 ? 4 : 5;
}

interface Tri { fid: number; t: number; area: number; n: Vec3 }

/** Area lights for the glowing triangles of one body mesh.
 *
 *  `index` is the mesh's index buffer. Bodies are indexed, so triangle t's
 *  corners are index[3t..3t+2] and NOT vertices 3t..3t+2. Pass null only for a
 *  mesh that really is a triangle soup. */
export function areaEmitters(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  faceIds: ArrayLike<number>,
  glowing: (fid: number) => boolean,
): AreaEmitter[] {
  const corner = (t: number, k: number) => (index ? index[t * 3 + k]! : t * 3 + k) * 3;
  const byFace = new Map<number, Tri[]>();
  for (let t = 0; t < faceIds.length; t++) {
    const fid = faceIds[t]!;
    if (!glowing(fid)) continue;
    const i0 = corner(t, 0), i1 = corner(t, 1), i2 = corner(t, 2);
    const ux = positions[i1]! - positions[i0]!, uy = positions[i1 + 1]! - positions[i0 + 1]!, uz = positions[i1 + 2]! - positions[i0 + 2]!;
    const vx = positions[i2]! - positions[i0]!, vy = positions[i2 + 1]! - positions[i0 + 1]!, vz = positions[i2 + 2]! - positions[i0 + 2]!;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const len = Math.hypot(cx, cy, cz);
    if (len <= 0) continue;
    let list = byFace.get(fid);
    if (!list) byFace.set(fid, (list = []));
    list.push({ fid, t, area: len / 2, n: [cx / len, cy / len, cz / len] });
  }

  // One patch per flat face; a curved face splits by facing direction.
  let patches = new Map<string, Tri[]>();
  for (const [fid, tris] of byFace) {
    const mean = meanNormal(tris);
    if (mean && tris.every((tr) => dot(tr.n, mean) >= FLAT_COS)) {
      patches.set(`f${fid}`, tris);
      continue;
    }
    for (const tr of tris) push(patches, `f${fid}:${facing(...tr.n)}`, tr);
  }
  if (patches.size > MAX_PATCHES_PER_BODY) {
    const merged = new Map<string, Tri[]>();
    for (const tris of patches.values()) for (const tr of tris) push(merged, `d${facing(...tr.n)}`, tr);
    patches = merged;
  }

  const out: AreaEmitter[] = [];
  for (const [key, tris] of patches) {
    const e = fitRectangle(key, tris, positions, corner);
    if (e) out.push(e);
  }
  return out;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function meanNormal(tris: Tri[]): Vec3 | null {
  let x = 0, y = 0, z = 0;
  for (const tr of tris) { x += tr.n[0] * tr.area; y += tr.n[1] * tr.area; z += tr.n[2] * tr.area; }
  const l = Math.hypot(x, y, z);
  return l > 0 ? [x / l, y / l, z / l] : null;
}

/** The smallest rectangle, in the patch's own plane, that covers every corner of
 *  its triangles projected onto that plane. Smallest by rotating calipers over
 *  the convex hull, so a panel at any angle in its plane gets a rectangle its own
 *  shape rather than an axis box around it. The plane sits at the patch's
 *  outermost point along the normal, so a domed patch's light is in front of
 *  the dome, not buried inside it. */
function fitRectangle(
  key: string,
  tris: Tri[],
  positions: ArrayLike<number>,
  corner: (t: number, k: number) => number,
): AreaEmitter | null {
  const n = meanNormal(tris);
  if (!n) return null;
  // any unit vector perpendicular to n, then the third axis
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = dot(helper, n);
  let u: Vec3 = [helper[0] - n[0] * d, helper[1] - n[1] * d, helper[2] - n[2] * d];
  const ul = Math.hypot(...u);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];

  const pts: [number, number][] = [];
  const faces = new Map<number, number>();
  let area = 0, far = -Infinity;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const tr of tris) {
    area += tr.area;
    faces.set(tr.fid, (faces.get(tr.fid) ?? 0) + tr.area);
    for (let k = 0; k < 3; k++) {
      const i = corner(tr.t, k);
      const p: Vec3 = [positions[i]!, positions[i + 1]!, positions[i + 2]!];
      pts.push([dot(p, u), dot(p, v)]);
      far = Math.max(far, dot(p, n));
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a]!, p[a]!); max[a] = Math.max(max[a]!, p[a]!); }
    }
  }
  const rect = minAreaRect(pts);
  if (!rect) return null;
  const [cu, cv] = rect.center;
  const ca = Math.cos(rect.angle), sa = Math.sin(rect.angle);
  return {
    key,
    center: [0, 1, 2].map((a) => u[a]! * cu + v[a]! * cv + n[a]! * far) as Vec3,
    normal: n,
    xAxis: [0, 1, 2].map((a) => u[a]! * ca + v[a]! * sa) as Vec3,
    width: Math.max(rect.w, 1e-3),
    height: Math.max(rect.h, 1e-3),
    area,
    faces,
    size: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1,
  };
}

/** Minimum area bounding rectangle of 2D points: centre, the angle of its width
 *  side from the +u axis, and its two side lengths. */
export function minAreaRect(pts: [number, number][]): { center: [number, number]; angle: number; w: number; h: number } | null {
  const hull = convexHull(pts);
  if (hull.length === 0) return null;
  if (hull.length < 3) {
    const [a, b] = [hull[0]!, hull[hull.length - 1]!];
    const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], angle: Math.atan2(b[1] - a[1], b[0] - a[0]), w, h: 0 };
  }
  let best: { center: [number, number]; angle: number; w: number; h: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i]!, q = hull[(i + 1) % hull.length]!;
    const angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const c = Math.cos(angle), s = Math.sin(angle);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * c + y * s, ry = -x * s + y * c;
      x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry);
    }
    const w = x1 - x0, h = y1 - y0;
    if (!best || w * h < best.w * best.h - 1e-9) {
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      best = { center: [mx * c - my * s, mx * s + my * c], angle, w, h };
    }
  }
  return best;
}

/** Andrew's monotone chain, counter clockwise, no collinear points. */
function convexHull(input: [number, number][]): [number, number][] {
  const pts = [...input].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** A patch's rectangle light luminance. The rectangle bounds the patch, so a
 *  disc or an L shaped face covers less than its rectangle: the luminance is
 *  scaled by the covered fraction, which keeps the light given off equal to
 *  what the real surface would give off. */
export function emitterLuminance(glow: number, e: Pick<AreaEmitter, "area" | "width" | "height">): number {
  return glow * EMITTER_LUMINANCE * Math.min(1, e.area / (e.width * e.height));
}
