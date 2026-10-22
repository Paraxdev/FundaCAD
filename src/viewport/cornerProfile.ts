// A rounded corner as a conic: the rational quadratic Bezier from one tangent
// point through the sharp vertex to the other, weights (1, w, 1). Its shape is
// rho, the CAD fillet "profile": where the corner's middle sits between the
// chord (0, a chamfer) and the vertex (1, a sharp corner).

export type Vec2 = readonly [number, number];

/** The rho of an exact circular arc over a right angle, w = cos 45 deg. */
export const CIRCLE_RHO = Math.SQRT2 - 1;

const MAX_RHO = 0.95;

export function conicWeight(rho: number): number {
  const r = Number.isNaN(rho) ? CIRCLE_RHO : Math.min(MAX_RHO, Math.max(0, rho));
  return r / (1 - r);
}

export function conicCorner(p0: Vec2, vertex: Vec2, p2: Vec2, rho: number, segments: number): Vec2[] {
  const w = conicWeight(rho);
  const n = Math.max(1, Math.round(segments) || 1);
  const out: Vec2[] = [[p0[0], p0[1]]];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const a = (1 - t) * (1 - t);
    const b = 2 * w * t * (1 - t);
    const c = t * t;
    const d = a + b + c;
    out.push([(a * p0[0] + b * vertex[0] + c * p2[0]) / d, (a * p0[1] + b * vertex[1] + c * p2[1]) / d]);
  }
  out.push([p2[0], p2[1]]);
  return out;
}

/** A square centred on the origin, counter clockwise from its (+, -) corner,
 *  each corner cut back `leg` along both sides and bridged by a conic. */
export function roundedSquare(size: number, leg: number, rho: number, segments: number): Vec2[] {
  const h = size / 2;
  const l = Math.min(h, Math.max(0, leg));
  const corners: Vec2[] = [[h, -h], [h, h], [-h, h], [-h, -h]];
  if (l === 0) return corners.map(([x, y]) => [x, y]);
  const out: Vec2[] = [];
  corners.forEach((v, i) => {
    const prev = corners[(i + 3) % 4]!;
    const next = corners[(i + 1) % 4]!;
    const toward = (to: Vec2): Vec2 => [v[0] + (Math.sign(to[0] - v[0]) * l), v[1] + (Math.sign(to[1] - v[1]) * l)];
    const arc = conicCorner(toward(prev), v, toward(next), rho, segments);
    // At a half size leg two neighbouring corners share their tangent point.
    out.push(...(l === h ? arc.slice(1) : arc));
  });
  return out;
}
