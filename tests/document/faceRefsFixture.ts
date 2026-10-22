// Real engine replies for the face material tests, see faceRefs.test.ts.
import fixture from "../fixtures/faceRefs.json";
import type { RebuildResult } from "../../src/types";

export type Scenario = keyof typeof fixture;
type Mesh = { id: string; faceCount: number; positions: number[]; indices: number[]; faceIds: number[] };

export function reply(name: Scenario, move?: (p: number[]) => number[]): RebuildResult {
  const positions: number[] = [],
    indices: number[] = [],
    faceIds: number[] = [];
  const bodies: NonNullable<RebuildResult["bodies"]> = [];
  let faceStart = 0;
  for (const b of fixture[name] as Mesh[]) {
    const base = positions.length / 3;
    const moved = b.id === "body1" && move;
    positions.push(...(moved ? move(b.positions) : b.positions));
    indices.push(...b.indices.map((i) => i + base));
    faceIds.push(...b.faceIds.map((f) => f + faceStart));
    bodies.push({
      id: b.id,
      name: b.id,
      faceStart,
      faceCount: b.faceCount,
      etag: b.id === "body2" ? "b2" : name + (moved ? "-moved" : ""),
    });
    faceStart += b.faceCount;
  }
  return { mesh: { positions, indices, faceIds }, edges: [], bbox: { min: [0, 0, 0], max: [1, 1, 1] }, bodies };
}

/** `name` after a Separate of body1: body1 keeps the run `keep` of its faces, a new body3 takes `take`. */
export function separated(name: Scenario, keep: number[], take: number[]): RebuildResult {
  const r = reply(name);
  const P = r.mesh.positions,
    I = r.mesh.indices,
    F = r.mesh.faceIds;
  const mesh = { positions: [] as number[], indices: [] as number[], faceIds: [] as number[] };
  const bodies: NonNullable<RebuildResult["bodies"]> = [];
  for (const [id, from, olds] of [
    ["body1", "body1", keep],
    ["body2", "body2", null],
    ["body3", "body1", take],
  ] as const) {
    const span = r.bodies!.find((b) => b.id === from)!;
    const local = olds ?? [...Array(span.faceCount).keys()];
    const faceStart = bodies.reduce((n, b) => n + b.faceCount, 0);
    const to = new Map(local.map((o, n) => [span.faceStart + o, faceStart + n]));
    F.forEach((f, t) => {
      if (!to.has(f)) return;
      for (let j = 0; j < 3; j++) {
        const v = I[3 * t + j]!;
        mesh.indices.push(mesh.positions.length / 3);
        mesh.positions.push(P[3 * v]!, P[3 * v + 1]!, P[3 * v + 2]!);
      }
      mesh.faceIds.push(to.get(f)!);
    });
    bodies.push({ id, name: id, faceStart, faceCount: local.length, etag: id === "body2" ? "b2" : `${name}-${id}` });
  }
  return { mesh, edges: [], bbox: r.bbox, bodies };
}

export const runs = (keep: number[], take: number[]) => [
  { id: "body1", faces: { from: keep[0]!, count: keep.length } },
  { id: "body3", faces: { from: take[0]!, count: take.length } },
];
