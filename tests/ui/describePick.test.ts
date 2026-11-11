import { afterEach, describe, expect, it } from "vitest";
import {
  describeChange,
  describePick,
  facingOf,
  type EdgeFacts,
  type FaceFacts,
  type PickFacts,
  type PlaneFacts,
} from "../../src/ui/describePick";
import { setLanguage } from "../../src/i18n";
import { setUnit, type Unit } from "../../src/ui/units";
import type { Vec3 } from "../../src/types";

afterEach(async () => {
  setUnit("mm");
  await setLanguage("system");
});

const rad = (deg: number) => (deg * Math.PI) / 180;
// Three times unit length, so a case also proves the normal is not assumed to be unit.
const tiltedFromZ = (deg: number, sign = 1): Vec3 => [3 * Math.sin(rad(deg)), 0, 3 * sign * Math.cos(rad(deg))];

describe("facingOf", () => {
  const cases: [string, Vec3, ReturnType<typeof facingOf>][] = [
    ["up", [0, 0, 1], { word: "up", tilt: 0 }],
    ["down", [0, 0, -1], { word: "down", tilt: 0 }],
    ["front is -Y", [0, -1, 0], { word: "front", tilt: 0 }],
    ["back is +Y", [0, 1, 0], { word: "back", tilt: 0 }],
    ["left is -X", [-1, 0, 0], { word: "left", tilt: 0 }],
    ["right is +X", [1, 0, 0], { word: "right", tilt: 0 }],
    ["-0 parts", [-0, -0, 1], { word: "up", tilt: 0 }],
    ["-0 parts on another axis", [-0, 1, -0], { word: "back", tilt: 0 }],
    ["a small tilt inside the limit", tiltedFromZ(1.2), { word: "up", tilt: 0 }],
    ["exactly 2 degrees", tiltedFromZ(2), { word: "up", tilt: 0 }],
    ["exactly 2 degrees below", tiltedFromZ(2, -1), { word: "down", tilt: 0 }],
    ["just past 2 degrees", tiltedFromZ(2.01), { word: "up", tilt: 2 }],
    ["rounded tilt", tiltedFromZ(19.6), { word: "up", tilt: 20 }],
    ["a tilt off Y", [0, -Math.cos(rad(25)), Math.sin(rad(25))], { word: "front", tilt: 25 }],
    ["tie of Z and Y goes Z", [0, Math.cos(rad(45)), Math.sin(rad(45))], { word: "up", tilt: 45 }],
    ["tie of Z and X goes Z", [Math.sin(rad(45)), 0, -Math.cos(rad(45))], { word: "down", tilt: 45 }],
    ["tie of Y and X goes Y", [Math.sin(rad(45)), -Math.cos(rad(45)), 0], { word: "front", tilt: 45 }],
    ["tie of all three goes Z", [2, -2, 2], { word: "up", tilt: 55 }],
    ["just off a tie takes the nearer", [0, Math.cos(rad(44.9)), Math.sin(rad(44.9))], { word: "back", tilt: 45 }],
    ["zero length", [0, 0, 0], null],
    ["not a number", [Number.NaN, 0, 1], null],
  ];
  for (const [name, n, want] of cases)
    it(name, () => {
      expect(facingOf(n)).toEqual(want);
    });
});

const flat: FaceFacts = {
  kind: "face",
  number: 4,
  surface: "plane",
  area: 2400,
  size: [60, 40],
  normal: [0, 0, 1],
  centroid: [113.5, -41.25, 37],
  body: "Body1",
  owner: "Extrude 1",
};
const bore: FaceFacts = {
  kind: "face",
  number: 7,
  surface: "cylinder",
  area: 628.319,
  axis: [0, 0, -1],
  radius: 5,
  length: 20,
  full: true,
  concave: true,
  centroid: [113.5, -41.25, 17],
  body: "Body1",
  owner: "Hole 1",
};
const edge: EdgeFacts = { kind: "edge", number: 11, curve: "line", length: 40, faces: [4, 7], body: "Body1" };
const without = <T extends object>(facts: T, ...keys: (keyof T)[]): T => {
  const copy = { ...facts };
  for (const k of keys) delete copy[k];
  return copy;
};
const originPlane: PlaneFacts = { kind: "plane", name: "XY", origin: true, normal: [0, 0, 1] };

type Case = {
  name: string;
  facts: PickFacts;
  label: string;
  hint?: string[];
  readout?: string[];
  spoken?: string[];
  never?: string[];
};

const CASES: Case[] = [
  {
    name: "flat and upright",
    facts: flat,
    label: "Flat face 4",
    hint: ["60 by 40 mm", "facing up", "Extrude 1"],
    readout: ["1 face", "flat", "60 by 40 mm", "facing up"],
    spoken: [
      "60 by 40 millimetres",
      "2400 square millimetres",
      "facing up",
      "at height 37 millimetres",
      "Body1",
      "from Extrude 1",
    ],
    never: ["tilted"],
  },
  {
    name: "flat facing down keeps its height, below zero in words",
    facts: { ...flat, normal: [0, 0, -1], centroid: [3, 4, -12.5] },
    label: "Flat face 4",
    spoken: ["facing down", "at height minus 12.5 millimetres"],
  },
  {
    name: "flat at a -0 height and normal",
    facts: { ...flat, normal: [-0, -0, 1], centroid: [3, 4, -0] },
    label: "Flat face 4",
    spoken: ["facing up", "at height 0 millimetres"],
    never: ["-0"],
  },
  {
    name: "flat and upright within the limit at exactly 2 degrees",
    facts: { ...flat, normal: tiltedFromZ(2) },
    label: "Flat face 4",
    hint: ["facing up"],
    spoken: ["facing up", "at height 37 millimetres"],
    never: ["tilted"],
  },
  {
    name: "flat just past 2 degrees reads tilted and has no height",
    facts: { ...flat, normal: tiltedFromZ(2.01) },
    label: "Flat face 4",
    hint: ["tilted 2° from up"],
    readout: ["tilted 2° from up"],
    spoken: ["tilted 2 degrees from up"],
    never: ["facing", "height"],
  },
  {
    name: "flat and upright on a wall has no height",
    facts: { ...flat, normal: [0, -1, 0] },
    label: "Flat face 4",
    spoken: ["facing front"],
    never: ["height"],
  },
  {
    name: "flat tied at 45 degrees names Z",
    facts: { ...flat, normal: [0, Math.cos(rad(45)), Math.sin(rad(45))] },
    label: "Flat face 4",
    hint: ["tilted 45° from up"],
  },
  {
    name: "flat with no size shows its area",
    facts: without(flat, "size"),
    label: "Flat face 4",
    hint: ["2400 mm²"],
    readout: ["2400 mm²"],
    spoken: ["2400 square millimetres"],
  },
  {
    name: "a bore, whatever way its axis points",
    facts: bore,
    label: "Hole 7",
    hint: ["diameter 10 mm", "20 mm long", "Hole 1"],
    readout: ["1 face", "hole", "⌀10 mm", "20 mm long"],
    spoken: ["diameter 10 millimetres", "20 millimetres long", "axis up", "Body1", "from Hole 1"],
    never: ["down"],
  },
  {
    name: "a boss",
    facts: { ...bore, concave: false, owner: "Extrude 2" },
    label: "Cylinder 7",
    hint: ["diameter 10 mm", "20 mm long", "Extrude 2"],
    readout: ["cylinder", "⌀10 mm"],
    never: ["Hole"],
  },
  {
    name: "a cylinder not known to be a bore",
    facts: { ...without(bore, "concave"), owner: null },
    label: "Cylinder 7",
  },
  {
    name: "a part arc, even a concave one",
    facts: { ...bore, full: false, radius: 3, owner: "Fillet 1", axis: [0, 1, 0] },
    label: "Round face 7",
    hint: ["radius 3 mm", "Fillet 1"],
    readout: ["round", "R3 mm"],
    spoken: ["radius 3 millimetres", "20 millimetres long", "axis front to back", "from Fillet 1"],
    never: ["diameter"],
  },
  {
    name: "a part arc is the round face the press and pull prompt names",
    facts: { ...bore, full: false, radius: 3 },
    label: "Round face 7",
    never: ["Rounded"],
  },
  {
    name: "a round flat cap says its diameter, not a square's sides",
    facts: { ...flat, size: [25, 25], area: Math.PI * 12.5 ** 2 },
    label: "Flat face 4",
    hint: ["diameter 25 mm"],
    readout: ["⌀25 mm"],
    spoken: ["diameter 25 millimetres", "facing up"],
    never: ["by 25"],
  },
  {
    name: "a square flat face keeps its sides",
    facts: { ...flat, size: [25, 25], area: 625 },
    label: "Flat face 4",
    hint: ["25 by 25 mm"],
    never: ["diameter"],
  },
  {
    name: "a body named as the feature that made it is said once",
    facts: { ...flat, body: "Box", owner: "Box" },
    label: "Flat face 4",
    hint: ["Box"],
    spoken: ["facing up, at height 37 millimetres, Box"],
    never: ["from Box"],
  },
  {
    name: "a body named apart from its feature says both",
    facts: { ...flat, body: "Box 2", owner: "Box" },
    label: "Flat face 4",
    spoken: ["Box 2, from Box"],
  },
  {
    name: "a round face not known to be whole says its radius",
    facts: { ...without(bore, "full"), axis: [1, 0, 0] },
    label: "Cylinder 7",
    hint: ["radius 5 mm"],
    spoken: ["radius 5 millimetres", "axis left to right"],
    never: ["diameter"],
  },
  {
    name: "a slanted axis",
    facts: { ...bore, axis: [Math.sin(rad(30)), 0, -Math.cos(rad(30))] },
    label: "Hole 7",
    spoken: ["axis tilted 30 degrees from up"],
  },
  {
    name: "a cone",
    facts: {
      kind: "face",
      number: 3,
      surface: "cone",
      area: 90.1,
      axis: [0, 1, 0],
      length: 8,
      full: true,
      concave: false,
    },
    label: "Cone 3",
    hint: ["8 mm long"],
    readout: ["cone", "8 mm long"],
    spoken: ["8 millimetres long", "axis front to back"],
  },
  {
    name: "a sphere says no axis or facing",
    facts: {
      kind: "face",
      number: 4,
      surface: "sphere",
      area: 50.2,
      radius: 2,
      concave: false,
      axis: [0, 0, 1],
      normal: [0, 0, 1],
    },
    label: "Sphere 4",
    hint: ["diameter 4 mm"],
    readout: ["sphere", "⌀4 mm"],
    spoken: ["diameter 4 millimetres"],
    never: ["axis", "facing"],
  },
  {
    name: "a torus says its tube and no axis",
    facts: { kind: "face", number: 5, surface: "torus", area: 44, radius: 1.5, axis: [0, 0, 1] },
    label: "Torus 5",
    hint: ["tube diameter 3 mm"],
    spoken: ["tube diameter 3 millimetres"],
    never: ["axis"],
  },
  {
    name: "a spline says its area and no axis or facing",
    facts: {
      kind: "face",
      number: 9,
      surface: "bspline",
      area: 412,
      axis: [0, 0, 1],
      normal: [0, 0, 1],
      owner: "Loft 1",
    },
    label: "Curved face 9",
    hint: ["412 mm²", "Loft 1"],
    readout: ["curved", "412 mm²"],
    spoken: ["412 square millimetres", "from Loft 1"],
    never: ["axis", "facing"],
  },
  {
    name: "the mesh's curved answer before the engine has spoken",
    facts: { kind: "face", number: 2, surface: "curved", radius: 2, full: true },
    label: "Curved face 2",
    hint: ["diameter 4 mm"],
  },
  {
    name: "another surface",
    facts: { kind: "face", number: 8, surface: "other", area: 12 },
    label: "Face 8",
    hint: ["12 mm²"],
    readout: ["1 face", "12 mm²"],
  },
  {
    name: "a scan's face with nothing but a number",
    facts: { kind: "face", number: 1, surface: "other" },
    label: "Face 1",
  },
  {
    name: "every fact missing from a flat face",
    facts: { kind: "face", number: 2, surface: "plane" },
    label: "Flat face 2",
    never: ["undefined", "null", "NaN"],
  },
  {
    name: "a missing owner and body",
    facts: { ...without(flat, "body"), owner: null },
    label: "Flat face 4",
    never: ["from", "null", "undefined"],
  },
  {
    name: "facts that are not numbers",
    facts: {
      ...without(flat, "centroid"),
      area: Number.NaN,
      size: [Number.POSITIVE_INFINITY, 40],
      normal: [0, 0, 0],
    },
    label: "Flat face 4",
    never: ["NaN", "Infinity", "facing", "height", "tilted"],
  },
  {
    name: "a band of three pieces",
    facts: { ...bore, pieces: 3 },
    label: "Hole 7",
    hint: ["in 3 pieces"],
    spoken: ["in 3 pieces"],
  },
  {
    name: "two pieces are the first said",
    facts: { ...bore, pieces: 2 },
    label: "Hole 7",
    spoken: ["in 2 pieces"],
  },
  {
    name: "one piece is not said",
    facts: { ...bore, pieces: 1 },
    label: "Hole 7",
    never: ["piece"],
  },
  {
    name: "a straight edge between two faces",
    facts: edge,
    label: "Straight edge 11",
    hint: ["40 mm", "faces 4 and 7"],
    readout: ["1 edge", "straight", "40 mm"],
    spoken: ["40 millimetres", "between face 4 and face 7", "Body1"],
  },
  {
    name: "a seam on one face",
    facts: { ...edge, faces: [7] },
    label: "Straight edge 11",
    hint: ["face 7"],
    spoken: ["on face 7"],
    never: ["between", "faces"],
  },
  {
    name: "an edge with its faces not known",
    facts: { ...edge, faces: [] },
    label: "Straight edge 11",
    never: ["face"],
  },
  {
    name: "an edge meeting three faces",
    facts: { ...edge, faces: [2, 5, 9] },
    label: "Straight edge 11",
    hint: ["faces 2, 5 and 9"],
    spoken: ["between face 2, face 5 and face 9"],
  },
  {
    name: "a whole circle edge",
    facts: { ...edge, curve: "circle", length: 62.83, radius: 10, owner: "Hole 1" },
    label: "Round edge 11",
    hint: ["62.83 mm", "diameter 20 mm", "Hole 1"],
    readout: ["round", "⌀20 mm"],
    spoken: ["diameter 20 millimetres", "from Hole 1"],
  },
  {
    name: "an arc edge",
    facts: { ...edge, curve: "arc", length: 4.71, radius: 3 },
    label: "Round edge 11",
    hint: ["radius 3 mm"],
    readout: ["R3 mm"],
    spoken: ["radius 3 millimetres"],
    never: ["diameter"],
  },
  {
    name: "a spline edge",
    facts: { ...edge, curve: "curve", length: 17.5 },
    label: "Curved edge 11",
    hint: ["17.5 mm"],
  },
  {
    name: "an origin plane",
    facts: originPlane,
    label: "XY plane",
    hint: ["origin"],
    readout: ["XY plane", "origin", "facing up"],
    spoken: ["XY plane", "origin", "facing up", "Enter starts a sketch"],
  },
  {
    name: "a datum plane keeps its own name, slanted",
    facts: { kind: "plane", name: "Plane 2", origin: false, normal: [0, Math.sin(rad(20)), Math.cos(rad(20))] },
    label: "Plane 2",
    hint: ["datum"],
    spoken: ["Plane 2", "datum", "tilted 20 degrees from up", "Enter starts a sketch"],
    never: ["origin", "plane plane"],
  },
];

// Voices skip or spell out these symbols, and read a unit abbreviation as letters.
const NOT_SPOKEN = /[²³°⌀·…\u2014\u2013]| - |\bmm\b|\bcm\b|\bin²|\bR\d/;

describe("describePick words", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const w = describePick(c.facts);
      expect(w.label).toBe(c.label);
      expect(w.spoken.startsWith(c.label)).toBe(true);
      for (const fact of c.hint ?? []) expect(w.hint).toContain(fact);
      for (const fact of c.readout ?? []) expect(w.readout).toContain(fact);
      for (const fact of c.spoken ?? []) expect(w.spoken).toContain(fact);
      for (const word of c.never ?? []) expect([w.label, w.hint, w.readout, w.spoken].join("|")).not.toContain(word);
      expect(w.spoken).not.toMatch(NOT_SPOKEN);
      for (const text of [w.label, w.hint, w.spoken]) {
        expect(text).not.toMatch(/^,|,\s*,|,\s*$|\s\s|\s,/);
        expect(text).not.toMatch(/[\u2014\u2013]| - /);
      }
      expect(w.readout).not.toMatch(/^·|·\s*·|·\s*$/);
    });
  }

  it("keeps the facts in the order the words table reads", () => {
    const { spoken } = describePick(flat);
    const at = ["Flat face 4", "60 by 40", "2400 square", "facing up", "at height", "Body1", "from Extrude 1"].map(
      (f) => spoken.indexOf(f),
    );
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(at).not.toContain(-1);
  });

  it("a hint leaves out what only speech says", () => {
    expect(describePick(flat).hint).not.toMatch(/Body1|height|square|from/);
    expect(describePick(bore).hint).not.toMatch(/axis/);
  });

  it("a part arc's hint leaves its length to speech", () => {
    expect(describePick({ ...bore, full: false }).hint).not.toContain("long");
  });
});

describe("describePick follows the display unit", () => {
  const cases: [Unit, string, string[]][] = [
    ["cm", "6 by 4 cm", ["6 by 4 centimetres", "24 square centimetres", "at height 3.7 centimetres"]],
    ["in", "2.36 by 1.57 in", ["2.36 by 1.57 inches", "3.72 square inches", "at height 1.46 inches"]],
  ];
  for (const [unit, hint, spoken] of cases)
    it(`a flat face in ${unit}`, () => {
      setUnit(unit);
      const w = describePick(flat);
      expect(w.hint).toContain(hint);
      expect(w.readout).toContain(hint);
      for (const f of spoken) expect(w.spoken).toContain(f);
      expect(`${w.hint}|${w.spoken}|${w.readout}`).not.toMatch(/millimetre|\bmm\b/);
    });

  it("a bore in inches is singular at one inch", () => {
    setUnit("in");
    const w = describePick({ ...bore, radius: 12.7, length: 25.4 });
    expect(w.spoken).toContain("diameter 1 inch,");
    expect(w.spoken).toContain("1 inch long");
    expect(w.hint).toContain("diameter 1 in");
    expect(w.readout).toContain("⌀1 in");
  });

  it("a size pair is singular on its last number only", () => {
    expect(describePick({ ...flat, size: [60, 1] }).spoken).toContain("60 by 1 millimetre,");
    setUnit("cm");
    expect(describePick({ ...flat, size: [10, 20] }).spoken).toContain("1 by 2 centimetres");
  });

  it("an edge in centimetres", () => {
    setUnit("cm");
    const w = describePick({ ...edge, length: 10 });
    expect(w.hint).toContain("1 cm");
    expect(w.spoken).toContain("1 centimetre,");
  });
});

describe("describeChange", () => {
  const names: Record<string, string> = {
    "f:body1:3": "Flat face 4",
    "f:body1:6": "Hole 7",
    "f:body2:0": "Flat face 1",
    "e:body1:10": "Straight edge 11",
    "e:body1:12": "Round edge 13",
    "p:o:XY": "XY plane",
  };
  const words = (key: string) => ({ label: names[key] ?? "?", spoken: `${names[key] ?? "?"}, in full` });
  const change = (prev: string[], next: string[]) => describeChange(prev, next, words);

  it("names the body of one added or removed on a body the rest are not on", () => {
    const bodyOf = (k: string) => (/^[fe]:/.test(k) ? k.split(":")[1]!.toUpperCase() : null);
    const on = (prev: string[], next: string[]) => describeChange(prev, next, words, bodyOf);
    expect(on(["f:body1:3"], ["f:body1:3", "f:body2:0"])).toBe("Flat face 1 of BODY2 added, 2 selected");
    expect(on(["f:body1:3", "f:body2:0"], ["f:body1:3"])).toBe("Flat face 1 of BODY2 removed, 1 selected");
    expect(on(["f:body1:3"], ["f:body1:3", "e:body1:10"])).toBe("Straight edge 11 added, 2 selected");
    expect(on(["f:body1:3", "f:body2:0"], ["f:body1:3", "f:body2:0", "f:body1:6"])).toBe("Hole 7 added, 3 selected");
  });

  it("says nothing when the selection did not change", () => {
    expect(change([], [])).toBeNull();
    expect(change(["f:body1:3"], ["f:body1:3"])).toBeNull();
    expect(change(["f:body1:3", "e:body1:10"], ["e:body1:10", "f:body1:3"])).toBeNull();
  });

  it("says nothing is selected once all of it goes", () => {
    expect(change(["f:body1:3"], [])).toMatch(/nothing selected/i);
    expect(change(["f:body1:3", "e:body1:10", "f:body1:6"], [])).toMatch(/nothing selected/i);
  });

  it("speaks the whole name of one item", () => {
    expect(change([], ["f:body1:3"])).toBe("Flat face 4, in full");
    expect(change(["f:body1:3"], ["f:body1:6"])).toBe("Hole 7, in full");
    expect(change(["f:body1:3", "f:body1:6", "e:body1:10"], ["p:o:XY"])).toBe("XY plane, in full");
  });

  it("speaks one added to some with the new count", () => {
    expect(change(["f:body1:3"], ["f:body1:3", "f:body1:6"])).toMatch(/^Hole 7 added\b.*\b2 selected/);
    expect(change(["f:body1:3", "f:body1:6"], ["f:body1:3", "f:body1:6", "e:body1:10"])).toMatch(
      /^Straight edge 11 added\b.*\b3 selected/,
    );
  });

  it("speaks one removed from several with the new count", () => {
    expect(change(["f:body1:3", "f:body1:6"], ["f:body1:3"])).toMatch(/^Hole 7 removed\b.*\b1 selected/);
    expect(change(["f:body1:3", "f:body1:6", "e:body1:10"], ["f:body1:6", "e:body1:10"])).toMatch(
      /^Flat face 4 removed\b.*\b2 selected/,
    );
  });

  it("counts by kind for any other change", () => {
    expect(change([], ["f:body1:3", "f:body1:6", "f:body2:0", "e:body1:10", "e:body1:12"])).toMatch(
      /^3 faces, 2 edges selected/,
    );
    expect(change(["f:body1:3", "f:body1:6"], ["e:body1:10", "e:body1:12"])).toMatch(/^2 edges selected/);
    expect(change(["f:body1:3"], ["f:body1:6", "e:body1:10"])).toMatch(/^1 face, 1 edge selected/);
    expect(change(["f:body1:3", "e:body1:10"], ["f:body1:6", "e:body1:10", "p:o:XY"])).toMatch(
      /^1 face, 1 edge, 1 plane selected/,
    );
  });

  it("counts faces, then edges, then planes, whatever order the keys come in", () => {
    expect(change([], ["p:o:XY", "e:body1:10", "f:body1:3"])).toMatch(/^1 face, 1 edge, 1 plane selected/);
  });

  it("counts a key of no known kind as an item, not as nothing", () => {
    expect(change([], ["x:1", "x:2"])).toMatch(/^2 items selected/);
    expect(change([], ["f:body1:3", "x:1", "x:2", "e:body1:10"])).toMatch(/^1 face, 1 edge, 2 items selected/);
  });

  it("counts bodies and profiles by their own nouns", () => {
    expect(change([], ["b:body1", "b:body2"])).toMatch(/^2 bodies selected/);
    expect(change([], ["f:body1:3", "b:body1", "r:3.5", "r:-8.25"])).toMatch(/^1 face, 1 body, 2 profiles selected/);
  });

  it("a repeated key counts once", () => {
    expect(change([], ["f:body1:3", "f:body1:3"])).toBe("Flat face 4, in full");
  });

  it("asks for the words of only what it says", () => {
    const asked: string[] = [];
    const spy = (k: string) => {
      asked.push(k);
      return words(k);
    };
    describeChange(["f:body1:3"], ["f:body1:3", "f:body1:6"], spy);
    describeChange([], ["f:body1:3", "f:body1:6", "f:body2:0"], spy);
    expect(asked).toEqual(["f:body1:6"]);
  });
});

describe("describePick in a comma language", () => {
  const slanted: FaceFacts = {
    ...flat,
    area: 2435.125,
    size: [60.5, 40.25],
    centroid: [113.5, -41.25, 37.5],
  };
  const slantedBore: FaceFacts = { ...bore, radius: 5.25, length: 20.5, centroid: [1, 2, 3] };

  it("reads a flat face with a decimal comma and keeps commas between the facts", async () => {
    await setLanguage("de");
    expect(describePick(slanted)).toEqual({
      label: "Ebene Fläche 4",
      hint: "60,5 by 40,25 mm, facing up, Extrude 1",
      readout: "1 Fläche · eben · 60,5 by 40,25 mm · facing up",
      aloud: "1 Fläche · eben, 60,5 by 40,25 mm, facing up",
      spoken:
        "Ebene Fläche 4, 60,5 by 40,25 Millimeter, 2435,125 Quadratmillimeter, facing up, at height 37,5 Millimeter, Body1, from Extrude 1",
    });
  });

  it("reads a bore with a decimal comma in inches", async () => {
    await setLanguage("de");
    setUnit("in");
    expect(describePick(slantedBore)).toEqual({
      label: "Bohrung 7",
      hint: "diameter 0,413 in, 0,807 in long, Hole 1",
      readout: "1 Fläche · Bohrung · ⌀0,413 in · 0,807 in long",
      aloud: "1 Fläche · Bohrung, ⌀0,413 in, 0,807 in long",
      spoken: "Bohrung 7, diameter 0,413 Zoll, 0,807 Zoll long, axis up, Body1, from Hole 1",
    });
  });

  it("keeps the point and the comma in English", () => {
    expect(describePick(slanted)).toEqual({
      label: "Flat face 4",
      hint: "60.5 by 40.25 mm, facing up, Extrude 1",
      readout: "1 face · flat · 60.5 by 40.25 mm · facing up",
      aloud: "1 face · flat, 60.5 by 40.25 mm, facing up",
      spoken:
        "Flat face 4, 60.5 by 40.25 millimetres, 2435.125 square millimetres, facing up, at height 37.5 millimetres, Body1, from Extrude 1",
    });
  });
});
