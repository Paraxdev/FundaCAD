// A body whose etag a reply repeats keeps its GPU mesh, but its global face ids
// must follow the reply: a fillet on an earlier body adds a face, every later
// body starts one face further on, and the engine etag (local ids) cannot see it.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ProgressiveModel } from "../../src/viewport/progressive";
import { bodyOfFace, buildBodyMesh, reuseUnchanged, type BodyMesh, type ModelView } from "../../src/viewport/render";
import type { RebuildResult } from "../../src/types";

const RES = new THREE.Vector2(800, 600);

/** One triangle per face on its own slanted vertices away from the origin. The
 *  first vertex's x is 100 * body + local face, so a triangle names its face. */
function reply(counts: number[], etags: string[]): RebuildResult {
  const positions: number[] = [],
    indices: number[] = [],
    faceIds: number[] = [];
  const bodies: NonNullable<RebuildResult["bodies"]> = [];
  let fid = 0;
  counts.forEach((n, b) => {
    bodies.push({ id: `body${b + 1}`, name: `Body${b + 1}`, faceStart: fid, faceCount: n, etag: etags[b]! });
    for (let f = 0; f < n; f++, fid++) {
      const v0 = positions.length / 3;
      const x = 100 * b + f;
      positions.push(x, -7.5 + 0.3 * f, 12.25, x + 2.5, -6 + 0.3 * f, 13.5, x + 0.5, -4.25, 15 + 0.7 * f);
      indices.push(v0, v0 + 1, v0 + 2);
      faceIds.push(fid);
    }
  });
  return { mesh: { positions, indices, faceIds }, edges: [], bbox: { min: [0, -8, 12], max: [300, 0, 30] }, bodies };
}

function built(r: RebuildResult): BodyMesh[] {
  return r.bodies!.map((m) => buildBodyMesh(r, m, [], RES, m.etag));
}

/** Per global face id: the owning body and the "100 * body + local" its triangle carries. */
function faceMap(bodies: BodyMesh[]) {
  const out: Record<number, [string, number]> = {};
  for (const b of bodies) {
    const pos = b.mesh.geometry.getAttribute("position");
    const idx = b.mesh.geometry.getIndex()!;
    for (const [fid, tris] of b.faceTriangles) {
      out[fid] = [b.id, Math.round(pos.getX(idx.getX(tris[0]! * 3)))];
    }
  }
  return out;
}

const view = (bodies: BodyMesh[]) =>
  ({ bodies, edges: [], orphanEdges: null, box: new THREE.Box3() }) as unknown as ModelView;

describe("reuseUnchanged", () => {
  const before = reply([6, 6], ["a6", "b"]);

  it("refuses without a previous mesh, without an etag, or for another etag", () => {
    const [, body2] = built(before);
    expect(reuseUnchanged(undefined, { etag: "b", faceStart: 6 })).toBeUndefined();
    expect(reuseUnchanged(body2, { faceStart: 6 })).toBeUndefined();
    expect(reuseUnchanged(body2, { etag: "b2", faceStart: 6 })).toBeUndefined();
    expect(body2!.faceIds).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it("keeps the ids of a body that starts where it did", () => {
    const [, body2] = built(before);
    expect(reuseUnchanged(body2, { etag: "b", faceStart: 6 })).toBe(body2);
    expect(body2!.faceIds).toEqual([6, 7, 8, 9, 10, 11]);
    expect([...body2!.faceTriangles.keys()]).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it("moves every id of a body that now starts one face later or two earlier", () => {
    const [, body2] = built(before);
    expect(reuseUnchanged(body2, { etag: "b", faceStart: 7 })).toBe(body2);
    expect(body2!.faceStart).toBe(7);
    expect(body2!.faceIds).toEqual([7, 8, 9, 10, 11, 12]);
    expect([...body2!.faceTriangles]).toEqual([
      [7, [0]],
      [8, [1]],
      [9, [2]],
      [10, [3]],
      [11, [4]],
      [12, [5]],
    ]);
    reuseUnchanged(body2, { etag: "b", faceStart: 5 });
    expect(body2!.faceIds).toEqual([5, 6, 7, 8, 9, 10]);
    expect(faceMap([body2!])).toEqual({
      5: ["body2", 100],
      6: ["body2", 101],
      7: ["body2", 102],
      8: ["body2", 103],
      9: ["body2", 104],
      10: ["body2", 105],
    });
  });
});

describe("a fillet on the first of three bodies", () => {
  const before = reply([6, 6, 4], ["a6", "b", "c"]);
  const after = reply([7, 6, 4], ["a7", "b", "c"]);
  const want: Record<number, [string, number]> = {};
  for (let f = 0; f < 7; f++) want[f] = ["body1", f];
  for (let f = 0; f < 6; f++) want[7 + f] = ["body2", 100 + f];
  for (let f = 0; f < 4; f++) want[13 + f] = ["body3", 200 + f];

  it("leaves the streamed model's face ids where the reply puts them", () => {
    const prev = view(built(before));
    const pm = new ProgressiveModel(new THREE.Group(), () => {});
    pm.begin(0, after.bodies!, after, new THREE.Box3(), prev, new Set());
    const m = after.bodies![0]!;
    pm.append(0, after, [m], new Map([["body1", []]]), { triStart: 0, triEnd: 7 }, new Set(), RES);
    const bodies = pm.current!.bodies;
    expect(bodies.map((b) => [b.id, b.faceStart])).toEqual([
      ["body1", 0],
      ["body2", 7],
      ["body3", 13],
    ]);
    expect(bodies[1]).toBe(prev.bodies[1]);
    expect(faceMap(bodies)).toEqual(want);
    const owners = Object.keys(want).map((fid) => bodyOfFace(pm.current!, Number(fid))?.id);
    expect(owners).toEqual(Object.values(want).map(([b]) => b));
  });
});
