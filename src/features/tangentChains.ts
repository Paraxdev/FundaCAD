import * as THREE from "three";
import type { EdgeRef } from "../viewport/edgeLines";

type Vec3 = [number, number, number];
type End = { p: Vec3; t: THREE.Vector3 }; // endpoint + unit tangent there

const G1_COS = Math.cos((10 * Math.PI) / 180); // tangents within 10°

function endsOf(l: EdgeRef): End[] {
  const pts = l.points as Vec3[];
  const first = pts[0];
  const second = pts[1];
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  if (!first || !second || !last || !prev) return [];
  const tHead = new THREE.Vector3(second[0] - first[0], second[1] - first[1], second[2] - first[2]).normalize();
  const tTail = new THREE.Vector3(last[0] - prev[0], last[1] - prev[1], last[2] - prev[2]).normalize();
  return [
    { p: first, t: tHead },
    { p: last, t: tTail },
  ];
}

const hash = (x: number, y: number, z: number) =>
  Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791);

/** Points bucketed in cells of `tol`, so a lookup within `tol` checks the 27 cells around it. */
class PointCells<T> {
  private readonly cells = new Map<number, { p: Vec3; v: T }[]>();
  constructor(private readonly tol: number) {}
  private c(v: number) {
    return Math.floor(v / this.tol);
  }
  add(p: Vec3, v: T) {
    const k = hash(this.c(p[0]), this.c(p[1]), this.c(p[2]));
    const list = this.cells.get(k);
    if (list) list.push({ p, v });
    else this.cells.set(k, [{ p, v }]);
  }
  /** Every value stored within `tol` of `p`, hash collisions filtered out by distance. */
  near(p: Vec3, out: T[] = []): T[] {
    const cx = this.c(p[0]),
      cy = this.c(p[1]),
      cz = this.c(p[2]);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const e of this.cells.get(hash(cx + dx, cy + dy, cz + dz)) ?? []) {
            if (Math.hypot(e.p[0] - p[0], e.p[1] - p[1], e.p[2] - p[2]) <= this.tol) out.push(e.v);
          }
        }
    return out;
  }
}

/** Mids already taken, two within `tol` are one edge. */
export class MidSet {
  private readonly cells: PointCells<true>;
  constructor(tol = 1e-6) {
    this.cells = new PointCells(tol);
  }
  has(p: Vec3): boolean {
    return this.cells.near(p).length > 0;
  }
  add(p: Vec3) {
    this.cells.add(p, true);
  }
}

/** The tangent chains of one set of edges, indexed by endpoint once so a chain costs its own length, not a scan of
 *  every edge per member. */
export class TangentChains {
  private readonly ends: End[][];
  private readonly cells: PointCells<number>;
  private readonly at: Map<EdgeRef, number>;

  constructor(
    private readonly all: readonly EdgeRef[],
    private readonly joinTol: number,
  ) {
    this.cells = new PointCells(joinTol);
    this.ends = all.map(endsOf);
    this.at = new Map(all.map((l, i) => [l, i]));
    this.ends.forEach((es, i) => es.forEach((e) => this.cells.add(e.p, i)));
  }

  /** Breadth first across shared endpoints whose end tangents are colinear, `start` included. Edges come in the
   *  order a scan of `all` would find them. */
  chain(start: EdgeRef): EdgeRef[] {
    const chain = new Set<EdgeRef>([start]);
    const queue: EdgeRef[] = [start];
    while (queue.length) {
      const cur = queue.pop();
      if (!cur) break;
      const at = this.at.get(cur);
      for (const ce of (at === undefined ? undefined : this.ends[at]) ?? endsOf(cur)) {
        const cands = [...new Set(this.cells.near(ce.p))].sort((a, b) => a - b);
        for (const i of cands) {
          const cand = this.all[i];
          if (!cand || chain.has(cand)) continue;
          for (const oe of this.ends[i] ?? []) {
            const d = Math.hypot(ce.p[0] - oe.p[0], ce.p[1] - oe.p[1], ce.p[2] - oe.p[2]);
            if (d > this.joinTol) continue;
            if (Math.abs(ce.t.dot(oe.t)) < G1_COS) continue;
            chain.add(cand);
            queue.push(cand);
            break;
          }
        }
      }
    }
    return [...chain];
  }
}
