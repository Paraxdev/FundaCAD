// A corner is the superellipse |x|^n + |y|^n = 1 in the box between its tangent points and the
// centre opposite its vertex: n 1 is a chamfer, 2 a circle, 4 the CSS `corner-shape: squircle`.

export type Vec2 = readonly [number, number];

export const CIRCLE_EXPONENT = 2;
/** CSS `corner-shape: squircle` is `superellipse(2)`, the exponent 2^2. */
export const SQUIRCLE_EXPONENT = 4;
export const MAX_EXPONENT = 32;

// Points go at even polar angles from the centre, an even parameter would leave gaps at the ends.
export function superellipseCorner(p0: Vec2, vertex: Vec2, p2: Vec2, exponent: number, segments: number): Vec2[] {
  const e = Number.isNaN(exponent) ? CIRCLE_EXPONENT : Math.min(MAX_EXPONENT, Math.max(1, exponent));
  const n = Math.max(1, Math.round(segments) || 1);
  const c: Vec2 = [p0[0] + p2[0] - vertex[0], p0[1] + p2[1] - vertex[1]];
  const out: Vec2[] = [[p0[0], p0[1]]];
  for (let i = 1; i < n; i++) {
    const phi = ((i / n) * Math.PI) / 2;
    const cs = Math.cos(phi);
    const sn = Math.sin(phi);
    const r = (cs ** e + sn ** e) ** (-1 / e);
    const a = r * cs;
    const b = r * sn;
    out.push([c[0] + a * (p0[0] - c[0]) + b * (p2[0] - c[0]), c[1] + a * (p0[1] - c[1]) + b * (p2[1] - c[1])]);
  }
  out.push([p2[0], p2[1]]);
  return out;
}

/** A square centred on the origin, counter clockwise from its (+, -) corner,
 *  each corner cut back `leg` along both sides and bridged by a superellipse. */
export function roundedSquare(size: number, leg: number, exponent: number, segments: number): Vec2[] {
  const h = size / 2;
  const l = Math.min(h, Math.max(0, leg));
  const corners: Vec2[] = [
    [h, -h],
    [h, h],
    [-h, h],
    [-h, -h],
  ];
  if (l === 0) return corners.map(([x, y]) => [x, y]);
  const out: Vec2[] = [];
  corners.forEach((v, i) => {
    const prev = corners[(i + 3) % 4]!;
    const next = corners[(i + 1) % 4]!;
    const toward = (to: Vec2): Vec2 => [v[0] + Math.sign(to[0] - v[0]) * l, v[1] + Math.sign(to[1] - v[1]) * l];
    const arc = superellipseCorner(toward(prev), v, toward(next), exponent, segments);
    // At a half size leg two neighbouring corners share their tangent point.
    out.push(...(l === h ? arc.slice(1) : arc));
  });
  return out;
}
