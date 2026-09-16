// The one-line readout for what is selected: how many, and for edges and round
// faces the numbers you would otherwise reach for Measure to get.

export type Pt3 = readonly [number, number, number];

/** Total length of a polyline. */
export function polylineLength(points: readonly Pt3[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return len;
}

/** Diameter of a closed polyline that is a circle, else null. A tessellated
 *  circle's vertices all sit on it, so every vertex has to be within a small
 *  fraction of the mean radius, which a rounded rectangle or an ellipse is not. */
export function circleDiameter(points: readonly Pt3[], tol = 0.01): number | null {
  if (points.length < 8) return null;
  const first = points[0]!, last = points[points.length - 1]!;
  const span = polylineLength(points);
  const gap = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]);
  if (gap > span * 1e-3) return null;
  const ring = points.slice(0, -1);
  let cx = 0, cy = 0, cz = 0;
  for (const p of ring) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= ring.length; cy /= ring.length; cz /= ring.length;
  const radii = ring.map((p) => Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz));
  const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
  if (mean <= 0) return null;
  return radii.every((r) => Math.abs(r - mean) <= mean * tol) ? mean * 2 : null;
}

const mm = (v: number) => `${Number(v.toFixed(2))} mm`;

/** "1 edge · 300.74 mm · ⌀95.73 mm", "3 faces", "1 face · ⌀50 mm". */
export function describeSelection(input: {
  count: number;
  noun: string;
  plural: string;
  edges?: readonly (readonly Pt3[])[];
  roundFaceDiameter?: number | null;
}): string {
  if (input.count <= 0) return "";
  const parts = [`${input.count} ${input.count === 1 ? input.noun : input.plural}`];
  if (input.edges?.length) {
    parts.push(mm(input.edges.reduce((s, e) => s + polylineLength(e), 0)));
    const d = input.edges.length === 1 ? circleDiameter(input.edges[0]!) : null;
    if (d !== null) parts.push(`⌀${mm(d)}`);
  } else if (input.roundFaceDiameter != null) {
    parts.push(`⌀${mm(input.roundFaceDiameter)}`);
  }
  return parts.join(" · ");
}
