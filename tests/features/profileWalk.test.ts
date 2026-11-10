import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { walkStep, walkUnits, walkWords } from "../../src/features/profileWalk";
import { circleLoop, rectCorners, type Region } from "../../src/sketch/region";
import { setLanguage } from "../../src/i18n";
import { setUnit } from "../../src/ui/units";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
// area of the 64 sided circle loop the sketch really uses
const disc = (r: number) => 32 * r * r * Math.sin((2 * Math.PI) / 64);

function region(loop: THREE.Vector2[], holes: THREE.Vector2[][], interior: THREE.Vector2): Region {
  return { sketchId: "s1", loop, holes, centroid: interior, interior };
}
const plate = (x: number, y: number, w: number, h: number, hole?: { cx: number; cy: number; r: number }) =>
  region(rectCorners(x, y, w, h), hole ? [circleLoop(hole.cx, hole.cy, hole.r)] : [], v(x + 1, y + 1));
const wr = (r: Region, groupId?: string) => (groupId === undefined ? { region: r } : { region: r, groupId });

afterEach(async () => {
  setUnit("mm");
  await setLanguage("system");
});

describe("walkUnits", () => {
  it("is empty for no regions", () => {
    expect(walkUnits([])).toEqual([]);
  });

  it("gives one unit for one region", () => {
    const only = wr(plate(5, 7, 13, 9));
    const units = walkUnits([only]);
    expect(units).toHaveLength(1);
    expect(units[0]!.members).toEqual([only]);
    expect(units[0]!.area).toBeCloseTo(117, 9);
    expect(units[0]!.holes).toBe(0);
  });

  it("lists a plate with a hole before the disc in the hole, largest first", () => {
    const disk = wr(region(circleLoop(25, 3, 5), [], v(25, 3)));
    const slab = wr(plate(5, -7, 40, 20, { cx: 25, cy: 3, r: 5 }));
    const small = wr(plate(60, 1, 3, 2));
    const units = walkUnits([disk, small, slab]);
    expect(units.map((u) => u.members[0])).toEqual([slab, disk, small]);
    expect(units.map((u) => u.holes)).toEqual([1, 0, 0]);
    expect(units[0]!.area).toBeCloseTo(800 - disc(5), 9);
    expect(units[1]!.area).toBeCloseTo(disc(5), 9);
    expect(units[2]!.area).toBeCloseTo(6, 9);
  });

  it("breaks an equal area tie by position, then by input order", () => {
    const right = wr(plate(30, 2, 4, 4));
    const left = wr(plate(-8, 9, 4, 4));
    const lowLeft = wr(plate(-8, -3, 4, 4));
    expect(walkUnits([right, left, lowLeft]).map((u) => u.members[0])).toEqual([lowLeft, left, right]);
    const a = wr(plate(2, 2, 4, 4));
    const b = wr(plate(2, 2, 4, 4));
    expect(walkUnits([a, b]).map((u) => u.members[0])).toEqual([a, b]);
    expect(walkUnits([b, a]).map((u) => u.members[0])).toEqual([b, a]);
  });

  it("treats the glyphs of one text as one profile with their areas and holes added", () => {
    const g1 = wr(plate(0, 0, 3, 5, { cx: 1.5, cy: 2.5, r: 1 }), "s1:t1");
    const g2 = wr(plate(5, 0, 3, 5), "s1:t1");
    const g3 = wr(plate(10, 0, 3, 5), "s1:t2");
    const big = wr(plate(20, 20, 30, 30));
    const units = walkUnits([g3, g1, big, g2]);
    expect(units).toHaveLength(3);
    expect(units[0]!.members).toEqual([big]);
    expect(units[1]!.members).toEqual([g1, g2]);
    expect(units[1]!.area).toBeCloseTo(15 - disc(1) + 15, 9);
    expect(units[1]!.holes).toBe(1);
    expect(units[2]!.members).toEqual([g3]);
  });
});

describe("walkStep", () => {
  it("stays unlit for none", () => {
    expect(walkStep(0, -1, 1)).toBe(-1);
    expect(walkStep(0, 3, -1)).toBe(-1);
  });
  it("starts on the first going forward and the last going back", () => {
    expect(walkStep(4, -1, 1)).toBe(0);
    expect(walkStep(4, -1, -1)).toBe(3);
  });
  it("wraps both ways, and a single profile stays put", () => {
    expect(walkStep(4, 3, 1)).toBe(0);
    expect(walkStep(4, 0, -1)).toBe(3);
    expect(walkStep(4, 1, 1)).toBe(2);
    expect(walkStep(1, 0, 1)).toBe(0);
    expect(walkStep(1, 0, -1)).toBe(0);
  });
  it("treats an index past the end as unlit", () => {
    expect(walkStep(3, 9, 1)).toBe(0);
  });
});

describe("walkWords", () => {
  const slab = wr(plate(5, -7, 40, 20, { cx: 25, cy: 3, r: 5 }));
  const unit = walkUnits([slab])[0]!;

  it("carries the place in the walk, the area and the holes", () => {
    const s = walkWords(unit, 0, 3, false);
    expect(s).toContain("Profile 1 of 3");
    expect(s).toContain(`${Math.round((800 - disc(5)) * 100) / 100} mm²`);
    expect(s).toContain("1 hole");
    expect(s).not.toContain("picked");
  });
  it("says no holes, many holes and picked", () => {
    const flat = walkUnits([wr(plate(0, 0, 4, 3))])[0]!;
    expect(walkWords(flat, 1, 2, false)).toContain("no holes");
    const three = { ...flat, holes: 3 };
    const s = walkWords(three, 1, 2, true);
    expect(s).toContain("3 holes");
    expect(s).toContain("picked");
    expect(s).toContain("Profile 2 of 2");
  });
  it("names a text taken together", () => {
    const text = walkUnits([wr(plate(0, 0, 3, 5), "g"), wr(plate(5, 0, 3, 5), "g")])[0]!;
    expect(walkWords(text, 0, 1, false)).toContain("2 shapes");
  });
  it("follows the display unit", () => {
    setUnit("in");
    const flat = walkUnits([wr(plate(0, 0, 25.4, 50.8))])[0]!;
    expect(walkWords(flat, 0, 1, false)).toContain("2 in²");
  });
});

describe("walkWords in a comma language", () => {
  it("says the area with a decimal comma and keeps commas between the parts", async () => {
    const flat = walkUnits([wr(plate(0, 0, 4.5, 3.25))])[0]!;
    const english = walkWords({ ...flat, holes: 2 }, 0, 3, true);
    await setLanguage("de");
    expect([english, walkWords({ ...flat, holes: 2 }, 0, 3, true)]).toEqual([
      "Profile 1 of 3, area 14.625 mm², 2 holes, picked.",
      "Profile 1 of 3, area 14,625 mm², 2 holes, picked.",
    ]);
  });
});
