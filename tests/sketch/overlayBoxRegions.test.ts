// A box over a visible sketch picks its areas the way a click does, from what an additive box started with.
import { describe, expect, it } from "vitest";
import { SketchOverlay, type WorldRegion } from "../../src/sketch/overlay";
import { SketchPlane } from "../../src/sketch/plane";
import { detectRegions } from "../../src/sketch/region";

const plane = new SketchPlane("XY");
const circle = (id: string, x: number) => ({ type: "circle" as const, id, x, y: 0, radius: 5 });

function overlayWith(xs: number[]): SketchOverlay {
  const o = new SketchOverlay();
  o.regions = detectRegions(
    "s",
    xs.map((x, i) => circle(`c${i}`, x)),
  ).map((region): WorldRegion => ({
    sketchId: "s",
    region,
    plane,
    centroid3D: plane.to3D(region.centroid.x, region.centroid.y),
    interior3D: plane.to3D(region.interior.x, region.interior.y),
  }));
  return o;
}
const atX = (o: SketchOverlay) => o.selectedRegions().map((wr) => Math.round(wr.interior3D.x / 20) * 20 + 0);

describe("SketchOverlay.selectRegionsInBox", () => {
  it("takes the areas the box holds and says when the pick changed", () => {
    const o = overlayWith([0, 20, 40]);
    const left = (wr: WorldRegion) => wr.interior3D.x < 30;
    expect(o.selectRegionsInBox([], left)).toBe(true);
    expect(atX(o).sort()).toEqual([0, 20]);
    expect(o.selectRegionsInBox([], left)).toBe(false);
  });

  it("keeps what an additive box started from, and a plain box replaces it", () => {
    const o = overlayWith([0, 20, 40]);
    o.toggleRegionSelection(
      o.regions.find((wr) => wr.interior3D.x > 30)!,
      false,
    );
    const from = o.regionSelectionPoints();
    const first = (wr: WorldRegion) => wr.interior3D.x < 10;
    o.selectRegionsInBox(from, first);
    expect(atX(o).sort((a, b) => a - b)).toEqual([0, 40]);
    o.selectRegionsInBox([], first);
    expect(atX(o)).toEqual([0]);
    o.selectRegionsInBox([], () => false);
    expect(o.selectedRegions()).toEqual([]);
  });

  it("never takes a hole", () => {
    const o = overlayWith([0]);
    o.regions[0]!.hole = true;
    o.selectRegionsInBox([], () => true);
    expect(o.regionSelectionPoints()).toEqual([]);
  });
});
