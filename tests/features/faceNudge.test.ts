import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { faceNudgePlacement } from "../../src/features/faceNudge";
import type { RoundFace } from "../../src/features/radialDrag";

const pre = (normal: [number, number, number], anchor: [number, number, number] = [1, 2, 3]) => ({
  normal: new THREE.Vector3(...normal),
  anchor: new THREE.Vector3(...anchor),
});

const round = (radial: [number, number, number], solidInside: boolean): RoundFace => ({
  cylinder: { axis: [0, 0, 1], point: [0, 0, 0], radius: 5 },
  radius: 5,
  solidInside,
  radial: new THREE.Vector3(...radial),
});

describe("faceNudgePlacement", () => {
  it("offers nothing when no face is selected", () => {
    expect(faceNudgePlacement(null, () => {})).toBeNull();
  });

  it("stands the handle on the face and points it along the normal", () => {
    const place = faceNudgePlacement(pre([0, 0, 4]), () => {});
    expect(place?.anchor.toArray()).toEqual([1, 2, 3]);
    // Normalised: the arrow is scaled per frame to a constant screen size, so a
    // non-unit axis would only corrupt the orientation quaternion.
    expect(place?.axis({} as never).toArray()).toEqual([0, 0, 1]);
  });

  it("holds the axis still while the camera moves", () => {
    // The opposite of the EDGE handle, whose axis is defined against the camera
    // and must swing with an orbit. A face's normal belongs to the geometry: an
    // arrow that re-aimed on orbit would be pointing somewhere the push/pull
    // cannot actually go.
    const place = faceNudgePlacement(pre([0, 1, 0]), () => {});
    const first = place?.axis({} as never).clone();
    const second = place?.axis({} as never);
    expect(second?.toArray()).toEqual(first?.toArray());
  });

  it("copies the anchor rather than aliasing the caller's vector", () => {
    // selectedFacesForPressPull hands back live Vector3s. Holding one across a
    // rebuild would leave the arrow pointing wherever the next caller mutated
    // it to.
    const p = pre([0, 0, 1], [5, 5, 5]);
    const place = faceNudgePlacement(p, () => {});
    p.anchor.set(9, 9, 9);
    expect(place?.anchor.toArray()).toEqual([5, 5, 5]);
  });

  it("offers nothing for a degenerate normal", () => {
    // A zero normal has no direction to drag along; an arrow drawn from it
    // would be unorientable and the press/pull meaningless.
    expect(faceNudgePlacement(pre([0, 0, 0]), () => {})).toBeNull();
  });

  it("hands the press straight through to the tool", () => {
    const grab = vi.fn();
    faceNudgePlacement(pre([0, 0, 1]), grab)?.grab(120, 340);
    expect(grab).toHaveBeenCalledWith(120, 340);
  });

  it("points a ROUND face's handle away from the axis, not along the normal", () => {
    // The bug this fixes: a closed cylinder's facet normals cancel, so
    // faceNormalWorld falls back to world +Z and grabbing a shaft dragged it
    // upward. The radial is the direction a resize actually has.
    const place = faceNudgePlacement(
      { ...pre([0, 0, 1]), round: round([1, 0, 0], true) },
      () => {},
    );
    expect(place?.axis({} as never).toArray()).toEqual([1, 0, 0]);
  });

  it("points OUTWARD on a bore too, the sign is the tool's problem", () => {
    // Pulling the handle away from the axis means a bigger hole and a bigger
    // shaft alike. Flipping the arrow on a bore would make the gesture ask the
    // user to know which side the material is on before they can resize it.
    const place = faceNudgePlacement(
      { ...pre([0, 0, 1]), round: round([0, 1, 0], false) },
      () => {},
    );
    expect(place?.axis({} as never).toArray()).toEqual([0, 1, 0]);
  });

  it("falls back to the normal when the face is not round", () => {
    const place = faceNudgePlacement({ ...pre([0, 3, 0]), round: null }, () => {});
    expect(place?.axis({} as never).toArray()).toEqual([0, 1, 0]);
  });
});
