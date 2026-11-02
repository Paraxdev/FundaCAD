import { describe, expect, it } from "vitest";
import { nearestMeshFace } from "../../src/features/nearestMeshFace";
import type { RebuildResult } from "../../src/types";

// Two bodies off the origin: body a owns faces 0 (flat, z = 3 over x 2..6, y 1..5) and 1 (a slanted plane),
// body b owns face 2 (z = 3 too, over x 20..24).
const POS = [
  2,
  1,
  3,
  6,
  1,
  3,
  6,
  5,
  3,
  2,
  5,
  3, // face 0
  2,
  1,
  3,
  2,
  5,
  3,
  2,
  5,
  9,
  2,
  1,
  9, // face 1 (x = 2, a wall)
  20,
  1,
  3,
  24,
  1,
  3,
  24,
  5,
  3,
  20,
  5,
  3, // face 2
];
const IDX = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11];
const FACE_IDS = [0, 0, 1, 1, 2, 2];

function result(wire: "array" | "typed"): RebuildResult {
  const arr = <T extends number[]>(a: T) => a;
  return {
    mesh:
      wire === "array"
        ? { positions: arr(POS), indices: arr(IDX), faceIds: arr(FACE_IDS) }
        : { positions: new Float32Array(POS), indices: new Uint32Array(IDX), faceIds: new Uint32Array(FACE_IDS) },
    bodies: [
      { id: "a", name: "a", faceStart: 0, faceCount: 2 },
      { id: "b", name: "b", faceStart: 2, faceCount: 1 },
    ],
  } as unknown as RebuildResult;
}

describe("nearestMeshFace", () => {
  for (const wire of ["array", "typed"] as const) {
    it(`finds the face and the distance on ${wire} wire arrays`, () => {
      const r = result(wire);
      expect(nearestMeshFace(r, "a", [3.5, 2.25, 3.5])).toEqual({ faceId: 0, distance: 0.5 });
      expect(nearestMeshFace(r, "a", [1.25, 3, 6])).toEqual({ faceId: 1, distance: 0.75 });
      expect(nearestMeshFace(r, "a", [4, 3, 3])).toEqual({ faceId: 0, distance: 0 });
    });
  }

  it("looks only at the named body, so a nearer face of another body does not count", () => {
    const r = result("array");
    expect(nearestMeshFace(r, "a", [22, 3, 3])).toEqual({ faceId: 0, distance: 16 });
    expect(nearestMeshFace(r, "b", [22, 3, 3.5])).toEqual({ faceId: 2, distance: 0.5 });
  });

  it("is null for a body that is not in the mesh", () => {
    expect(nearestMeshFace(result("array"), "c", [3, 3, 3])).toBeNull();
    const { bodies: _, ...noBodies } = result("array");
    expect(nearestMeshFace(noBodies, "a", [3, 3, 3])).toBeNull();
  });
});
