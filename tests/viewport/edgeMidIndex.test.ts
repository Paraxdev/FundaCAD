// The mid index answers what nearestEdgeByMid answers, without a scan of every model edge per lookup: a fillet on
// 20,000 preselected edges did 20,000 scans of the whole model before.

import { describe, expect, it } from "vitest";
import { EdgeMidIndex, nearestEdgeByMid, polylineMid, type Vec3 } from "../../src/viewport/edgeMatch";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

describe("EdgeMidIndex", () => {
  it("matches nearestEdgeByMid on both mid conventions, ties to the first edge, across cell borders", () => {
    const r = rng(7);
    const tol = 0.05;
    // Coordinates on a 0.05 grid put mids on cell borders and make exact ties.
    const q = (v: number) => Math.round(v * 20) / 20;
    const edges: { points: Vec3[] }[] = [];
    for (let i = 0; i < 3000; i++) {
      const a: Vec3 = [q(r() * 4), q(r() * 4), q(r() * 4)];
      const pts: Vec3[] = [a];
      const n = 1 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) pts.push([q(a[0] + r() * 0.3), q(a[1] + r() * 0.3), q(a[2] + r() * 0.3)]);
      edges.push({ points: pts });
    }
    edges.push({ points: edges[5]!.points.map((p) => [...p] as Vec3) });
    edges.push({ points: [] });
    const index = new EdgeMidIndex(edges, tol);
    for (let k = 0; k < 4000; k++) {
      const base = edges[Math.floor(r() * 3000)]!.points;
      const mid = k % 3 === 0 ? polylineMid(base)! : k % 3 === 1 ? base[Math.floor(base.length / 2)]! : base[0]!;
      const j = k % 4 === 0 ? 0 : (r() - 0.5) * 2 * tol;
      const p: Vec3 = [mid[0] + j, mid[1] - j, mid[2] + j * 0.5];
      expect(index.nearest(p)).toBe(nearestEdgeByMid(edges, p, tol));
    }
    expect(index.nearest(polylineMid(edges[5]!.points)!)).toBe(
      nearestEdgeByMid(edges, polylineMid(edges[5]!.points)!, tol),
    );
    expect(index.nearest([100, 100, 100])).toBeNull();
  });

  it("builds over 100k edges and answers 20k lookups in well under the time of one scan per lookup", () => {
    const edges: { points: Vec3[] }[] = [];
    for (let i = 0; i < 100_000; i++) {
      const x = (i % 400) * 3,
        y = Math.floor(i / 400) * 3;
      edges.push({
        points: [
          [x, y, 0],
          [x + 1, y, 0],
        ],
      });
    }
    const t0 = performance.now();
    const index = new EdgeMidIndex(edges, 0.01);
    let hits = 0;
    for (let k = 0; k < 20_000; k++) {
      const e = edges[k * 5]!.points;
      if (index.nearest([(e[0]![0] + e[1]![0]) / 2, e[0]![1], 0]) === k * 5) hits++;
    }
    const ms = performance.now() - t0;
    expect(hits).toBe(20_000);
    expect(ms).toBeLessThan(2000);
  });

  it("a non positive tolerance matches nothing, as the scan does", () => {
    const edges = [
      {
        points: [
          [0, 0, 0],
          [1, 0, 0],
        ] as Vec3[],
      },
    ];
    expect(new EdgeMidIndex(edges, 0).nearest([0.5, 0, 0])).toBe(nearestEdgeByMid(edges, [0.5, 0, 0], 0));
  });
});
