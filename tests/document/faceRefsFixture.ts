// Real engine replies for the face material tests, see faceRefs.test.ts.
import fixture from "../fixtures/faceRefs.json";
import type { RebuildResult } from "../../src/types";

export type Scenario = keyof typeof fixture;
type Mesh = { id: string; faceCount: number; positions: number[]; indices: number[]; faceIds: number[] };

export function reply(name: Scenario, move?: (p: number[]) => number[]): RebuildResult {
  const positions: number[] = [], indices: number[] = [], faceIds: number[] = [];
  const bodies: NonNullable<RebuildResult["bodies"]> = [];
  let faceStart = 0;
  for (const b of fixture[name] as Mesh[]) {
    const base = positions.length / 3;
    const moved = b.id === "body1" && move;
    positions.push(...(moved ? move(b.positions) : b.positions));
    indices.push(...b.indices.map((i) => i + base));
    faceIds.push(...b.faceIds.map((f) => f + faceStart));
    bodies.push({ id: b.id, name: b.id, faceStart, faceCount: b.faceCount, etag: b.id === "body2" ? "b2" : name + (moved ? "-moved" : "") });
    faceStart += b.faceCount;
  }
  return { mesh: { positions, indices, faceIds }, edges: [], bbox: { min: [0, 0, 0], max: [1, 1, 1] }, bodies };
}
