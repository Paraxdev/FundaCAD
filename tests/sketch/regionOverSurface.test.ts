import { describe, it, expect } from "vitest";
import { regionBeatsSurface, type RegionSurfaceTie } from "../../src/sketch/regionOverSurface";

// A 100mm cube, a profile on its bottom face 200mm from the camera.
const onFace: RegionSurfaceTie = {
  regionDist: 200,
  surfaceDist: 200,
  modelScale: 173,
  regionArea: 10_000,
  faceArea: 10_000,
};

describe("regionBeatsSurface", () => {
  it("keeps the profile when there is no body under the ray", () => {
    expect(regionBeatsSurface({ ...onFace, surfaceDist: null })).toBe(true);
  });

  it("hides a profile behind the body", () => {
    expect(regionBeatsSurface({ ...onFace, surfaceDist: 100, regionArea: 314 })).toBe(false);
  });

  it("keeps a profile floating in front of the body", () => {
    expect(regionBeatsSurface({ ...onFace, surfaceDist: 300 })).toBe(true);
  });

  it("gives a coplanar profile tracing the whole face to the face", () => {
    expect(regionBeatsSurface(onFace)).toBe(false);
    expect(regionBeatsSurface({ ...onFace, regionArea: 9_950, surfaceDist: 200.2 })).toBe(false);
  });

  it("keeps a coplanar profile that is a proper sub-area of the face", () => {
    expect(regionBeatsSurface({ ...onFace, regionArea: 314 })).toBe(true);
    expect(regionBeatsSurface({ ...onFace, regionArea: 9_500 })).toBe(true);
  });

  it("scales the depth tolerance with the model", () => {
    // 0.2mm off is coplanar on a 173mm model but in front of a 10mm one
    expect(regionBeatsSurface({ ...onFace, surfaceDist: 200.2 })).toBe(false);
    expect(regionBeatsSurface({ ...onFace, surfaceDist: 200.2, modelScale: 10 })).toBe(true);
  });

  it("keeps the profile when the face area is unknown", () => {
    expect(regionBeatsSurface({ ...onFace, faceArea: 0 })).toBe(true);
  });
});
