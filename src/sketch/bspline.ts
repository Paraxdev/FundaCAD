// Control-point B-spline math, the same curve the engine builds
// (crates/fundacad-geom kernel::edge_bspline), checked against it through
// tests/vectors/bspline.json.
//
// Knots: `knots` holds the DISTINCT knot values. An open curve has n - p + 1 of
// them, the two ends repeated p + 1 times and every interior knot once; a closed
// (periodic) curve has n + 1, each once, the period being last - first. Absent or
// malformed knots mean uniform 0, 1, 2, ..., which is what a freshly drawn curve
// has. Only pole insertion writes knots, because inserting a pole without moving
// the curve is only possible on a non-uniform knot vector.

export type Pt = { x: number; y: number };
export interface BsplineDef {
  poles: Pt[];
  degree?: number;
  closed?: boolean;
  knots?: number[];
}

export const BSPLINE_DEGREES = [2, 3, 5] as const;
export const DEFAULT_BSPLINE_DEGREE = 3;

/** The degree the curve is built with: the requested one, lowered to fit the pole count. */
export function bsplineDegree(def: BsplineDef): number {
  const want = def.degree ?? DEFAULT_BSPLINE_DEGREE;
  const d = Number.isFinite(want) ? Math.max(1, Math.round(want)) : DEFAULT_BSPLINE_DEGREE;
  return Math.max(1, Math.min(d, def.poles.length - 1));
}

/** Whether the definition builds a curve at all. */
export function bsplineValid(def: BsplineDef): boolean {
  return def.poles.length >= (def.closed ? 3 : 2);
}

/** The distinct knots the curve is built with, see the file header. */
export function bsplineKnots(def: BsplineDef): number[] {
  const n = def.poles.length;
  const p = bsplineDegree(def);
  const m = def.closed ? n + 1 : n - p + 1;
  const k = def.knots;
  if (k && k.length === m && k.every((v, i) => Number.isFinite(v) && (i === 0 || v > k[i - 1]!))) return [...k];
  return Array.from({ length: Math.max(m, 0) }, (_, i) => i);
}

/** The full knot sequence and the pole list it indexes (poles wrapped for a closed curve). */
function flat(def: BsplineDef): { t: number[]; P: Pt[]; p: number } {
  const p = bsplineDegree(def);
  const u = bsplineKnots(def);
  const n = def.poles.length;
  if (!def.closed) {
    const t = [...Array(p).fill(u[0]), ...u, ...Array(p).fill(u[u.length - 1])];
    return { t, P: def.poles, p };
  }
  const T = u[n]! - u[0]!;
  const t: number[] = [];
  for (let j = n - p; j < n; j++) t.push(u[j]! - T);
  t.push(...u);
  for (let j = 1; j <= p; j++) t.push(u[j]! + T);
  const P = [...def.poles, ...def.poles.slice(0, p)];
  return { t, P, p };
}

/** The parameter range [start, end] of the curve. */
export function bsplineRange(def: BsplineDef): [number, number] {
  const u = bsplineKnots(def);
  return [u[0] ?? 0, u[u.length - 1] ?? 0];
}

function span(t: number[], p: number, nP: number, x: number): number {
  let lo = p, hi = nP - 1;
  if (x >= t[hi + 1]!) return hi;
  if (x <= t[lo]!) return lo;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x < t[mid]!) hi = mid;
    else lo = mid;
  }
  // skip zero-length spans (clamped ends) so the span always has t[m] < t[m+1]
  while (lo < nP - 1 && t[lo + 1]! <= x) lo++;
  return lo;
}

/** de Boor evaluation at parameter `x` (clamped to the range). */
export function bsplinePoint(def: BsplineDef, x: number): Pt {
  const { t, P, p } = flat(def);
  const m = span(t, p, P.length, x);
  const d: Pt[] = [];
  for (let j = 0; j <= p; j++) {
    const q = P[j + m - p]!;
    d.push({ x: q.x, y: q.y });
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const lo = t[j + m - p]!, hi = t[j + 1 + m - r]!;
      const a = hi > lo ? (x - lo) / (hi - lo) : 0;
      const A = d[j - 1]!, B = d[j]!;
      d[j] = { x: (1 - a) * A.x + a * B.x, y: (1 - a) * A.y + a * B.y };
    }
  }
  return d[p]!;
}

/** The curve as a polyline, `segsPerSpan` samples in each knot span; a closed
 *  curve repeats its first point at the end. */
export function bsplinePolyline(def: BsplineDef, segsPerSpan = 16): Pt[] {
  if (!bsplineValid(def)) return def.poles.map((q) => ({ x: q.x, y: q.y }));
  const u = bsplineKnots(def);
  const out: Pt[] = [];
  for (let k = 0; k + 1 < u.length; k++) {
    const a = u[k]!, b = u[k + 1]!;
    for (let s = 0; s < segsPerSpan; s++) out.push(bsplinePoint(def, a + ((b - a) * s) / segsPerSpan));
  }
  out.push(def.closed ? { ...out[0]! } : bsplinePoint(def, u[u.length - 1]!));
  return out;
}

/** The parameter of the point on the curve nearest `q`: a sampled search refined by
 *  golden-section in the bracketing samples. */
export function bsplineNearestParam(def: BsplineDef, q: Pt): number {
  const [a, b] = bsplineRange(def);
  const N = Math.max(64, (bsplineKnots(def).length - 1) * 24);
  const d2 = (x: number) => { const c = bsplinePoint(def, x); return (c.x - q.x) ** 2 + (c.y - q.y) ** 2; };
  let best = a, bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const x = a + ((b - a) * i) / N;
    const d = d2(x);
    if (d < bestD) { bestD = d; best = x; }
  }
  let lo = Math.max(a, best - (b - a) / N), hi = Math.min(b, best + (b - a) / N);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 60; it++) {
    const x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
    if (d2(x1) < d2(x2)) hi = x2;
    else lo = x1;
  }
  return (lo + hi) / 2;
}

/** Boehm knot insertion: one more pole, the same curve. Null when `x` is outside
 *  the range or on an existing knot (a knot is stored once, see the file header). */
export function bsplineInsertKnot(def: BsplineDef, x: number): BsplineDef | null {
  if (!bsplineValid(def)) return null;
  const u = bsplineKnots(def);
  const p = bsplineDegree(def);
  const tol = 1e-9 * Math.max(1, Math.abs(u[u.length - 1]! - u[0]!));
  if (!(x > u[0]! + tol && x < u[u.length - 1]! - tol)) return null;
  if (u.some((v) => Math.abs(v - x) <= tol)) return null;
  const k = u.findIndex((v, i) => v <= x && x < u[i + 1]!);
  const lerp = (A: Pt, B: Pt, a: number): Pt => ({ x: (1 - a) * A.x + a * B.x, y: (1 - a) * A.y + a * B.y });
  const knots = [...u.slice(0, k + 1), x, ...u.slice(k + 1)];
  const base = { ...def, knots };
  if (!def.closed) {
    const { t, P } = flat(def);
    const m = k + p; // the flat span holding x
    const Q: Pt[] = [];
    for (let i = 0; i <= P.length; i++) {
      if (i <= m - p) Q.push({ ...P[i]! });
      else if (i >= m + 1) Q.push({ ...P[i - 1]! });
      else {
        const a = (x - t[i]!) / (t[i + p]! - t[i]!);
        Q.push(lerp(P[i - 1]!, P[i]!, a));
      }
    }
    return { ...base, poles: Q };
  }
  const n = def.poles.length;
  const T = u[n]! - u[0]!;
  const tau = (j: number) => {
    const w = Math.floor(j / n);
    return u[j - w * n]! + w * T;
  };
  const P = (i: number) => def.poles[((i % n) + n) % n]!;
  const Q: Pt[] = [];
  for (let i = 0; i <= n; i++) Q.push(i <= k ? { ...P(i) } : { ...P(i - 1) });
  for (let i = k + 1; i <= k + p; i++) {
    const a = (x - tau(i - p)) / (tau(i) - tau(i - p));
    Q[i % (n + 1)] = lerp(P(i - 1), P(i), a);
  }
  return { ...base, poles: Q };
}

/** The fewest poles a curve of this degree keeps, what pole deletion stops at. */
export function bsplineMinPoles(def: BsplineDef): number {
  const want = def.degree ?? DEFAULT_BSPLINE_DEGREE;
  return Math.max(def.closed ? 3 : 2, want + 1);
}

/** Remove pole `k`. Stored knots lose the interior knot nearest that pole's
 *  influence, so the rest of the curve keeps its spacing. Null at the minimum. */
export function bsplineRemovePole(def: BsplineDef, k: number): BsplineDef | null {
  const n = def.poles.length;
  if (k < 0 || k >= n || n - 1 < bsplineMinPoles(def)) return null;
  const poles = def.poles.filter((_, i) => i !== k);
  if (!def.knots) return { ...def, poles };
  const u = bsplineKnots(def);
  const p = bsplineDegree(def);
  const { t } = flat(def);
  let g = 0;
  for (let j = 1; j <= p; j++) g += t[k + j]!;
  g /= p; // Greville abscissa of pole k
  let drop = -1, dd = Infinity;
  for (let j = 1; j < u.length - 1; j++) {
    const d = Math.abs(u[j]! - g);
    if (d < dd) { dd = d; drop = j; }
  }
  const knots = drop > 0 ? u.filter((_, j) => j !== drop) : u;
  const next: BsplineDef = { ...def, poles, knots };
  const built = bsplineKnots(next);
  if (built.length === knots.length && built.every((v, i) => v === knots[i])) return next;
  delete next.knots; // the degree dropped with the pole count, uniform again
  return next;
}

/** Pole reference index, the `p` a constraint uses: 0 is the first pole, 1 the
 *  last (so endpoint-only tools keep working), and interior pole k is k + 1. */
export function poleRef(k: number, n: number): number {
  if (k === 0) return 0;
  if (k === n - 1) return 1;
  return k + 1;
}

/** Inverse of poleRef, -1 for an index that names no pole. */
export function poleOfRef(p: number, n: number): number {
  if (n < 1) return -1;
  if (p === 0) return 0;
  if (p === 1) return n - 1;
  const k = p - 1;
  return k >= 1 && k <= n - 2 ? k : -1;
}

/** Solve A x = b in place (Gaussian elimination with partial pivoting). */
function solveLinear(A: number[][], b: number[][]): number[][] | null {
  const n = A.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    if (Math.abs(A[piv]![c]!) < 1e-14) return null;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    [b[c], b[piv]] = [b[piv]!, b[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = A[r]![c]! / A[c]![c]!;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r]![k]! -= f * A[c]![k]!;
      for (let k = 0; k < b[r]!.length; k++) b[r]![k]! -= f * b[c]![k]!;
    }
  }
  const x = b.map((row) => row.map(() => 0));
  for (let r = n - 1; r >= 0; r--) {
    for (let k = 0; k < b[r]!.length; k++) {
      let s = b[r]![k]!;
      for (let c = r + 1; c < n; c++) s -= A[r]![c]! * x[c]![k]!;
      x[r]![k] = s / A[r]![r]!;
    }
  }
  return x;
}

/** Least-squares control polygon, uniform knots, for a curve sampled as `samples`
 *  (in order; a closed curve's samples do not repeat the first point). An open
 *  fit keeps both ends exactly. This is an approximation of the sampled shape,
 *  close but not exact, which is what converting a fit-point spline needs. */
export function bsplineFit(samples: Pt[], nPoles: number, closed: boolean, degree = DEFAULT_BSPLINE_DEGREE): BsplineDef | null {
  if (samples.length < 2 || nPoles < (closed ? 3 : 2)) return null;
  // chord-length parameters, mapped onto the uniform knot range
  const cum = [0];
  const pts = closed ? [...samples, samples[0]!] : samples;
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const L = cum[cum.length - 1]!;
  if (!(L > 0)) return null;
  const shape: BsplineDef = { poles: Array.from({ length: nPoles }, () => ({ x: 0, y: 0 })), degree, closed };
  const [a, b] = bsplineRange(shape);
  let params = cum.slice(0, samples.length).map((c) => a + ((b - a) * c) / L);
  const fixed = closed ? [] : [0, nPoles - 1];
  const known = new Map<number, Pt>(closed ? [] : [[0, samples[0]!], [nPoles - 1, samples[samples.length - 1]!]]);
  const free = Array.from({ length: nPoles }, (_, j) => j).filter((j) => !fixed.includes(j));
  const basis = (x: number): number[] => {
    const row: number[] = [];
    for (let j = 0; j < nPoles; j++) {
      const poles = shape.poles.map((_, i) => ({ x: i === j ? 1 : 0, y: 0 }));
      row.push(bsplinePoint({ ...shape, poles }, x).x);
    }
    return row;
  };
  let fit: BsplineDef | null = null;
  // a few rounds of parameter correction: chord length is only a first guess
  for (let round = 0; round < 5; round++) {
    const A = free.map(() => free.map(() => 0));
    const B = free.map(() => [0, 0]);
    params.forEach((x, s) => {
      const row = basis(x);
      let rx = samples[s]!.x, ry = samples[s]!.y;
      for (const [j, q] of known) { rx -= row[j]! * q.x; ry -= row[j]! * q.y; }
      free.forEach((j, r) => {
        free.forEach((l, c) => { A[r]![c]! += row[j]! * row[l]!; });
        B[r]![0]! += row[j]! * rx;
        B[r]![1]! += row[j]! * ry;
      });
    });
    const X = free.length ? solveLinear(A, B) : [];
    if (!X) return fit;
    const poles = shape.poles.map((_, j) => {
      const q = known.get(j);
      if (q) return { x: q.x, y: q.y };
      const r = X[free.indexOf(j)]!;
      return { x: r[0]!, y: r[1]! };
    });
    fit = { poles, degree, closed };
    const cur = fit;
    params = params.map((x, s) => (closed || (s > 0 && s < samples.length - 1) ? bsplineNearestParam(cur, samples[s]!) : x));
  }
  return fit;
}

/** The curve's own settings, only the ones set, for copying onto transformed poles. */
export function bsplineShape(e: { degree?: number | undefined; closed?: boolean | undefined; knots?: number[] | undefined }): { degree?: number; closed?: boolean; knots?: number[] } {
  return {
    ...(e.degree !== undefined ? { degree: e.degree } : {}),
    ...(e.closed ? { closed: true } : {}),
    ...(e.knots ? { knots: [...e.knots] } : {}),
  };
}
