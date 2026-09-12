import { describe, expect, it } from "vitest";
import {
  EMITTER_LIGHT_GAIN, emitterIntensity, emitterReach, emitterStandoff, faceEmitterShapes,
} from "../../src/viewport/emitters";

/** An indexed unit square in z=h (two triangles, face 7) plus a triangle on a
 *  far away face 3, laid out so that reading triangle t's corners as vertices
 *  3t..3t+2 lands on the wrong face's corners. */
function mesh(h = 0) {
  const positions = [
    100, 100, 100, // 0: face 3
    0, 0, h, // 1
    1, 0, h, // 2
    1, 1, h, // 3
    0, 1, h, // 4
    101, 100, 100, // 5: face 3
    100, 101, 100, // 6: face 3
  ];
  const index = [0, 5, 6, 1, 2, 3, 1, 3, 4];
  const faceIds = [3, 7, 7];
  return { positions, index, faceIds };
}

describe("emitter light brightness", () => {
  it("lights a surface one emitter size away the same at any scale", () => {
    // irradiance at distance d is intensity / d^2
    for (const size of [2, 20, 200]) expect(emitterIntensity(0.5, size) / size ** 2).toBeCloseTo(0.5 * EMITTER_LIGHT_GAIN);
  });

  it("is off with no glow and reaches a fixed number of sizes", () => {
    expect(emitterIntensity(0, 50)).toBe(0);
    expect(emitterReach(10) / emitterReach(1)).toBeCloseTo(10);
  });
});

describe("face emitter placement", () => {
  it("reads an indexed mesh's corners through its index", () => {
    const { positions, index, faceIds } = mesh(5);
    const s = faceEmitterShapes(positions, index, faceIds, (f) => f === 7).get(7)!;
    expect(s.position[0]).toBeCloseTo(0.5);
    expect(s.position[1]).toBeCloseTo(0.5);
    expect(s.normal).toEqual([0, 0, 1]);
    expect(s.size).toBeCloseTo(Math.SQRT2);
  });

  it("lifts a flat face's light off the surface on its front side", () => {
    const { positions, index, faceIds } = mesh(5);
    const s = faceEmitterShapes(positions, index, faceIds, (f) => f === 7).get(7)!;
    expect(s.position[2]).toBeCloseTo(5 + emitterStandoff(Math.SQRT2));
  });

  it("clears a domed face's apex, not just its centroid", () => {
    // a square pyramid, four triangles, apex 3 above a 2x2 base: its area centroid
    // sits well below the apex
    const positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, 0, 3];
    const index = [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4];
    const s = faceEmitterShapes(positions, index, [1, 1, 1, 1], () => true).get(1)!;
    expect(s.normal[2]).toBeCloseTo(1);
    expect(s.position[2]).toBeGreaterThan(3);
  });

  it("keeps a closed face's light at its centre and flags no front", () => {
    // a tetrahedron, outward winding: the area weighted normals cancel
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const index = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    const s = faceEmitterShapes(positions, index, [9, 9, 9, 9], () => true).get(9)!;
    expect(s.normal).toEqual([0, 0, 0]);
  });

  it("skips faces that do not glow", () => {
    const { positions, index, faceIds } = mesh();
    expect([...faceEmitterShapes(positions, index, faceIds, (f) => f === 7).keys()]).toEqual([7]);
  });
});
