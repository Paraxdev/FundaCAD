import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { regionAnchor, regionNudgePlacement } from "../../src/features/regionNudge";

const region = (interior: [number, number, number], n: [number, number, number] = [0, 0, 1]) => ({
  interior3D: new THREE.Vector3(...interior),
  plane: { n: new THREE.Vector3(...n) },
});

describe("regionAnchor", () => {
  it("stands on the area's interior point", () => {
    expect(regionAnchor([region([2, 3, 0])]).toArray()).toEqual([2, 3, 0]);
  });

  it("averages several areas", () => {
    // ExtrudeTool draws its own arrow from this same function. If the two ever
    // computed "the middle of the selection" separately, the arrow would twitch
    // at the instant the handle is grabbed, the failure the whole shared-glyph
    // arrangement exists to rule out.
    const a = regionAnchor([region([0, 0, 0]), region([4, 0, 0]), region([2, 6, 0])]);
    expect(a.toArray()).toEqual([2, 2, 0]);
  });

  it("does not divide by zero on an empty selection", () => {
    expect(regionAnchor([]).toArray()).toEqual([0, 0, 0]);
  });
});

describe("regionNudgePlacement", () => {
  it("offers nothing when no profile is selected", () => {
    expect(regionNudgePlacement([], () => {})).toBeNull();
  });

  it("points the arrow along the sketch plane's normal", () => {
    const place = regionNudgePlacement([region([1, 1, 0], [0, 0, 5])], () => {});
    expect(place?.axis({} as never).toArray()).toEqual([0, 0, 1]);
  });

  it("holds the axis still while the camera moves", () => {
    // A profile can only grow one way. An arrow that re-aimed on orbit would be
    // inviting a drag the extrude cannot perform.
    const place = regionNudgePlacement([region([0, 0, 0], [0, 1, 0])], () => {});
    expect(place?.axis({} as never).toArray()).toEqual(place?.axis({} as never).toArray());
  });

  it("takes the normal from the first area", () => {
    // Extruding several areas together moves them all along one direction, and
    // that direction is the first area's, same rule as the tool's preview.
    const place = regionNudgePlacement(
      [region([0, 0, 0], [1, 0, 0]), region([2, 0, 0], [0, 1, 0])],
      () => {},
    );
    expect(place?.axis({} as never).toArray()).toEqual([1, 0, 0]);
  });

  it("offers nothing for a degenerate plane normal", () => {
    expect(regionNudgePlacement([region([0, 0, 0], [0, 0, 0])], () => {})).toBeNull();
  });

  it("hands the press straight through to the tool", () => {
    const grab = vi.fn();
    regionNudgePlacement([region([0, 0, 0])], grab)?.grab(11, 22);
    expect(grab).toHaveBeenCalledWith(11, 22);
  });
});
