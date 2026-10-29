import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { MidSet, TangentChains } from "../../src/features/tangentChains";
import type { EdgeRef } from "../../src/viewport/edgeLines";

type P = [number, number, number];
const edge = (id: number, points: P[]) => ({ id: `e${id}`, points, body: "b1" }) as unknown as EdgeRef;

// The scan the index replaces: every member compares its ends with every edge.
function scanChain(all: EdgeRef[], start: EdgeRef, joinTol: number): EdgeRef[] {
  const G1 = Math.cos((10 * Math.PI) / 180);
  const ends = (l: EdgeRef) => {
    const p = l.points as P[];
    const [a, b, y, z] = [p[0]!, p[1]!, p[p.length - 1]!, p[p.length - 2]!];
    return [
      { p: a, t: new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize() },
      { p: y, t: new THREE.Vector3(y[0] - z[0], y[1] - z[1], y[2] - z[2]).normalize() },
    ];
  };
  const chain = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const ce of ends(cur))
      for (const cand of all) {
        if (chain.has(cand)) continue;
        for (const oe of ends(cand)) {
          if (Math.hypot(ce.p[0] - oe.p[0], ce.p[1] - oe.p[1], ce.p[2] - oe.p[2]) > joinTol) continue;
          if (Math.abs(ce.t.dot(oe.t)) < G1) continue;
          chain.add(cand);
          queue.push(cand);
          break;
        }
      }
  }
  return [...chain];
}

function model(): EdgeRef[] {
  const all: EdgeRef[] = [];
  for (let x = 0; x < 30; x++)
    all.push(
      edge(all.length, [
        [x, 0, 0],
        [x + 1, 0, 0],
      ]),
    );
  // A 5° kink joins, a 30° kink and a square corner do not.
  all.push(
    edge(all.length, [
      [30, 0, 0],
      [31, Math.tan((5 * Math.PI) / 180), 0],
    ]),
  );
  all.push(
    edge(all.length, [
      [0, 0, 0],
      [-1, Math.tan((30 * Math.PI) / 180), 0],
    ]),
  );
  all.push(
    edge(all.length, [
      [0, 0, 0],
      [0, 0, 1],
    ]),
  );
  // A circle of 40 segments turns 9° per joint, one chain; some edges are polylines of three points.
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * 2 * Math.PI,
      b = ((i + 1) / 40) * 2 * Math.PI,
      m = (a + b) / 2;
    const pts: P[] = [[10 * Math.cos(a), 10 * Math.sin(a) + 50, 2]];
    if (i % 3 === 0) pts.push([10 * Math.cos(m), 10 * Math.sin(m) + 50, 2]);
    pts.push([10 * Math.cos(b), 10 * Math.sin(b) + 50, 2]);
    all.push(edge(all.length, pts));
  }
  // Ends a hair apart inside the join tolerance, across a cell border.
  all.push(
    edge(all.length, [
      [99.9996, 7, 0],
      [100.0002, 7, 0],
    ]),
  );
  all.push(
    edge(all.length, [
      [100.0004, 7, 0],
      [101, 7, 0],
    ]),
  );
  all.push(
    edge(all.length, [
      [0, 0, 0],
      [1, 0, 0],
    ]),
  );
  return all;
}

describe("tangent chains from an endpoint index", () => {
  it("finds the same chain in the same order as the scan of every edge", () => {
    const all = model();
    const chains = new TangentChains(all, 1e-3);
    for (const start of all) expect(chains.chain(start)).toEqual(scanChain(all, start, 1e-3));
    const copy = edge(999, [
      [5, 0, 0],
      [6, 0, 0],
    ]);
    expect(chains.chain(copy)).toEqual(scanChain(all, copy, 1e-3));
  });

  it("chains 20,000 members over 100,000 edges in well under the scan's minutes", () => {
    const all: EdgeRef[] = [];
    for (let r = 0; r < 100; r++)
      for (let x = 0; x < 1000; x++)
        all.push(
          edge(all.length, [
            [x, r * 3, 0],
            [x + 1, r * 3, 0],
          ]),
        );
    const t0 = performance.now();
    const chains = new TangentChains(all, 1e-3);
    let n = 0;
    for (let r = 0; r < 20; r++) n += chains.chain(all[r * 1000]!).length;
    expect(n).toBe(20000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("takes two mids within the tolerance as one", () => {
    const s = new MidSet(1e-6);
    s.add([1, 2, 3]);
    expect(s.has([1 + 5e-7, 2, 3])).toBe(true);
    expect(s.has([1 + 5e-6, 2, 3])).toBe(false);
  });
});
