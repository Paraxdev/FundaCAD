import { afterEach, describe, expect, it } from "vitest";
import {
  ARROW_MAX_PX, ARROW_MIN_PX, ARROW_UNIT_PX, AXES, CUSTOM_MATERIAL, FORCE_DRAG_MAX,
  areaCentre, arrowPxToForce, autoDeformScale, barycentric, buildStressRequest, deformLabel, deformSliderMax,
  displacedPositions, dragForce, faceCountLabel, forceDragLabel, forceDragPatch, forceDragStart, forceToArrowPx,
  formatStressResult, gravityVector,
  newSetup, newSupport, panelMessage, pinAxisSegment, pressureSites, probeLabel, probeValues, roundSig, setupFromStudy,
  snapDrag, studyFromSetup, swingScale, type SnapCandidate, type StressFaceSet, type StressSetup, type Tri,
} from "../../src/ui/stress";
import { setUnit } from "../../src/ui/units";
import type { StressReply } from "../../src/geometry/client";
import type { Selector, Vec3 } from "../../src/types";

// The stress tools beyond the first panel: supports and gravity in the request,
// the study the document saves, the force arrow's drag, the deformed shape's
// scale, and the probe's interpolation.

afterEach(() => setUnit("mm"));

const top: Selector = { kind: "face", by: "nearest", point: [5, 5, 10], body: "b1" };
const bottom: Selector = { kind: "face", by: "nearest", point: [5, 5, 0], body: "b1" };
const hole: Selector = { kind: "face", by: "nearest", point: [3, 0, 5], body: "b1" };

function faces(sel: Selector, normal: Vec3, area = 100, ids = [3]): StressFaceSet {
  return { selectors: [sel], faceIds: ids, normalSum: [normal[0] * area, normal[1] * area, normal[2] * area], area };
}

function ready(): StressSetup {
  const s = newSetup("b1");
  s.supports[0]!.faces = faces(bottom, [0, 0, -1], 100, [1]);
  s.loads[0]!.faces = faces(top, [0, 0, 1]);
  return s;
}

describe("supports and gravity in the request", () => {
  it("sends every support with its kind, in order", () => {
    const s = ready();
    s.supports.push({ ...newSupport(2, "pinned"), faces: faces(hole, [1, 0, 0], 30, [5]) });
    s.supports.push({ ...newSupport(3, "slider"), faces: faces(top, [0, 0, 1], 100, [2]) });
    const r = buildStressRequest(s);
    expect(r.ok && r.options.supports).toEqual([
      { type: "fixed", faces: [bottom] },
      { type: "pinned", faces: [hole] },
      { type: "slider", faces: [top] },
    ]);
    expect(r.ok && "fixed" in r.options).toBe(false);
  });

  it("names the support that has no faces", () => {
    const s = ready();
    s.supports.push(newSupport(2, "pinned"));
    const r = buildStressRequest(s);
    expect(!r.ok && r.message).toBe("place support 2 on the body, or set its faces from a face selection");
    s.supports = [];
    const none = buildStressRequest(s);
    expect(!none.ok && none.message).toBe("add a support");
  });

  it("sends gravity as 9.81 m/s2 along its direction, and leaves it out when off", () => {
    const s = ready();
    const off = buildStressRequest(s);
    expect(off.ok && "gravity" in off.options).toBe(false);
    s.gravity = { on: true, direction: "-Z" };
    const r = buildStressRequest(s);
    expect(r.ok && r.options.gravity).toEqual([0, 0, -9.81]);
    expect(gravityVector("+X")).toEqual([9.81, 0, 0]);
    expect(gravityVector("-Y")).toEqual([0, -9.81, 0]);
  });

  it("runs a body under its own weight with no load", () => {
    const s = ready();
    s.loads = [];
    s.gravity.on = true;
    const r = buildStressRequest(s);
    expect(r.ok && r.options.loads).toEqual([]);
  });

  it("runs under gravity alone past the blank load a fresh panel starts with, but not past an edited one", () => {
    const s = ready();
    s.loads[0]!.faces = { selectors: [], faceIds: [], normalSum: [0, 0, 0], area: 0 };
    const off = buildStressRequest(s);
    expect(!off.ok && off.message).toBe("place the load on the body, or set its faces from a face selection");
    s.gravity.on = true;
    const r = buildStressRequest(s);
    expect(r.ok && r.options.loads).toEqual([]);
    expect(r.ok && r.options.gravity).toEqual([0, 0, -9.81]);
    s.loads[0]!.force = 40;
    const edited = buildStressRequest(s);
    expect(!edited.ok && edited.message).toBe("place the load on the body, or set its faces from a face selection");
  });

  it("refuses faces the current model lacks, naming their row", () => {
    const s = ready();
    s.supports[0]!.faces = { ...s.supports[0]!.faces, faceIds: [], missing: 1 };
    const r = buildStressRequest(s);
    expect(!r.ok && r.message).toBe("a face of the support is not found on the current model, set the faces again");
  });

  it("asks a custom material under gravity for its density, and sends it", () => {
    const s = ready();
    s.material = CUSTOM_MATERIAL;
    s.gravity.on = true;
    s.custom.density = "" as unknown as number;
    const r = buildStressRequest(s);
    expect(!r.ok && r.message).toBe("gravity needs the material's density in g/cm3");
    s.custom.density = 1.4;
    const ok = buildStressRequest(s);
    expect(ok.ok && ok.options.material).toEqual({ E: 2000, nu: 0.35, yield: 40, density: 1.4, name: "Custom" });
    // Without gravity a missing density is no reason to refuse.
    s.gravity.on = false;
    s.custom.density = 0;
    const off = buildStressRequest(s);
    expect(off.ok && off.options.material).toEqual({ E: 2000, nu: 0.35, yield: 40, name: "Custom" });
  });
});

describe("the study the document saves", () => {
  it("keeps selectors and settings, never face ids or normals", () => {
    const s = ready();
    s.supports.push({ ...newSupport(4, "pinned"), faces: faces(hole, [1, 0, 0], 30, [5]) });
    s.gravity = { on: true, direction: "-Y" };
    s.size = 1.5;
    const study = studyFromSetup(s);
    expect(study).toEqual({
      body: "b1",
      supports: [{ id: 1, type: "fixed", faces: [bottom] }, { id: 4, type: "pinned", faces: [hole] }],
      loads: [{ id: 1, kind: "force", faces: [top], force: 100, direction: "into", custom: [0, 0, -1], pressure: 0.1 }],
      gravity: { on: true, direction: "-Y" },
      material: "PLA",
      custom: { E: 2000, nu: 0.35, yield: 40, density: 1.2 },
      size: 1.5,
    });
    expect(JSON.stringify(study)).not.toContain("faceIds");
  });

  it("saves a cleared field as its default, not as a string", () => {
    const s = ready();
    s.loads[0]!.force = "" as unknown as number;
    s.custom.E = "" as unknown as number;
    s.size = "" as unknown as number;
    const study = studyFromSetup(s);
    expect(study.loads[0]!.force).toBe(100);
    expect(study.custom.E).toBe(2000);
    expect(study.size).toBeNull();
  });

  it("keeps the last value the user had in a cleared field, and a Run refuses the blank", () => {
    const s = ready();
    s.material = CUSTOM_MATERIAL;
    s.gravity.on = true;
    s.custom.density = 1.1;
    s.loads[0]!.force = 35;
    const before = studyFromSetup(s);
    s.custom.density = "" as unknown as number;
    s.loads[0]!.force = "" as unknown as number;
    const study = studyFromSetup(s, before);
    expect(study.custom.density).toBe(1.1);
    expect(study.loads[0]!.force).toBe(35);
    const r = buildStressRequest(s);
    expect(!r.ok && r.message).toBe("the load needs a force");
    s.loads[0]!.force = 35;
    const d = buildStressRequest(s);
    expect(!d.ok && d.message).toBe("gravity needs the material's density in g/cm3");
  });

  it("reads back through the face lookup it is given, and round-trips", () => {
    const s = ready();
    s.loads[0]!.direction = "custom";
    s.loads[0]!.custom = [1, 0, 0];
    const study = studyFromSetup(s);
    const seen: Selector[][] = [];
    const back = setupFromStudy(study, (sel) => {
      seen.push(sel);
      return { selectors: sel, faceIds: [9], normalSum: [0, 0, 1], area: 1 };
    });
    expect(seen).toEqual([[bottom], [top]]);
    expect(back.supports[0]!.faces.faceIds).toEqual([9]);
    expect(studyFromSetup(back)).toEqual(study);
    // The setup owns its copy: editing it leaves the study alone.
    back.loads[0]!.custom[0] = 5;
    expect(study.loads[0]!.custom[0]).toBe(1);
  });
});

describe("the force arrow", () => {
  it("maps force to length by its cube root and back, to two significant figures", () => {
    expect(forceToArrowPx(1)).toBe(ARROW_UNIT_PX);
    expect(forceToArrowPx(8)).toBeCloseTo(2 * ARROW_UNIT_PX, 9);
    expect(forceToArrowPx(1000)).toBeCloseTo(10 * ARROW_UNIT_PX, 9);
    expect(forceToArrowPx(-1000)).toBe(forceToArrowPx(1000));
    expect(forceToArrowPx(0)).toBe(ARROW_MIN_PX);
    expect(forceToArrowPx(1e12)).toBe(ARROW_MAX_PX);
    expect(arrowPxToForce(5 * ARROW_UNIT_PX)).toBe(130);
    expect(arrowPxToForce(forceToArrowPx(250))).toBe(250);
    expect(arrowPxToForce(forceToArrowPx(123.4))).toBe(120);
    expect(arrowPxToForce(5)).toBe(arrowPxToForce(ARROW_MIN_PX));
  });

  it("makes twice the arrow at most ten times the force, at any size", () => {
    for (const f of [0.5, 3, 30, 70, 100, 1500, 5e4]) {
      const start = forceDragStart(f, null);
      const doubled = dragForce(start, 2 * start.px);
      expect(doubled / f, `${f} N`).toBeLessThanOrEqual(10);
      expect(doubled / f, `${f} N`).toBeGreaterThan(5);
      expect(dragForce(start, start.px / 2) / f, `${f} N`).toBeGreaterThanOrEqual(0.1);
    }
    // Never past the largest force a drag sets, nor shorter than the shortest arrow.
    const big = forceDragStart(5e5, null);
    expect(dragForce(big, 10 * big.px)).toBe(FORCE_DRAG_MAX);
    const small = forceDragStart(30, null);
    expect(dragForce(small, 0)).toBe(dragForce(small, ARROW_MIN_PX));
  });

  it("measures a drag from where the press landed, so a press and let go changes nothing", () => {
    // A 30 N arrow pressed anywhere on its tip's grab ball (11 px round a point
    // 6.5 px behind the tip): the press itself is the arrow's own length.
    const px = forceToArrowPx(30);
    for (const press of [px - 6.5 - 11, px - 6.5, px - 6.5 + 11]) {
      const start = forceDragStart(30, press);
      expect(dragForce(start, press + start.offsetPx), `press at ${press}`).toBe(30);
      // One pixel out is a nudge, not a jump.
      const nudged = dragForce(start, press + 1 + start.offsetPx);
      expect(Math.abs(nudged - 30) / 30, `press at ${press}`).toBeLessThan(0.1);
    }
    // An arrow drawn at its longest for a force past the scale still starts
    // from that force.
    const huge = forceDragStart(5e4, ARROW_MAX_PX - 6);
    expect(huge.px).toBe(ARROW_MAX_PX);
    expect(dragForce(huge, ARROW_MAX_PX - 6 + huge.offsetPx)).toBe(5e4);
  });

  it("rounds to significant figures without a -0", () => {
    expect(roundSig(1234)).toBe(1200);
    expect(roundSig(0.04567)).toBe(0.046);
    expect(roundSig(-0.0001, 1)).toBe(-0.0001);
    expect(Object.is(roundSig(0), 0)).toBe(true);
  });

  const axes: SnapCandidate[] = Object.entries(AXES).map(([key, dir]) => ({ key: key as SnapCandidate["key"], dir }));
  const lookingDownY: Vec3 = [0, 1, 0];

  it("snaps to an axis within ten degrees on screen and measures along it", () => {
    const deg = (d: number) => (d * Math.PI) / 180;
    // 8 degrees off -Z in the XZ plane, the screen plane for a camera looking along +Y.
    const v: Vec3 = [Math.sin(deg(8)) * 50, 0, -Math.cos(deg(8)) * 50];
    const r = snapDrag(v, lookingDownY, axes)!;
    expect(r.key).toBe("-Z");
    expect(r.dir).toEqual([0, 0, -1]);
    expect(r.length).toBeCloseTo(50 * Math.cos(deg(8)), 9);
    // 15 degrees off is a direction of its own.
    const free = snapDrag([Math.sin(deg(15)), 0, -Math.cos(deg(15))], lookingDownY, axes)!;
    expect(free.key).toBe("custom");
    expect(free.dir[0]).toBeCloseTo(Math.sin(deg(15)), 12);
    expect(free.length).toBeCloseTo(1, 12);
  });

  it("snaps into the face, and passes over an axis pointing at the camera", () => {
    const into: Vec3 = [Math.SQRT1_2, 0, -Math.SQRT1_2];
    const r = snapDrag([1, 0, -1.05], lookingDownY, [...axes, { key: "into", dir: into }])!;
    expect(r.key).toBe("into");
    // +Y and -Y have no screen direction from here: a tiny drag is no snap to them.
    expect(snapDrag([0.001, 0, 0.001], lookingDownY, axes.filter((a) => a.key.endsWith("Y")))!.key).toBe("custom");
  });

  it("keeps a direction that leans into the screen when the drag runs along it", () => {
    const lean: Vec3 = [0.6, 0.8, 0];
    // On screen the arrow shows only its X part; dragging out along X to 1.2
    // means twice the shown length, so twice the arrow.
    const r = snapDrag([1.2, 0, 0], lookingDownY, [{ key: "custom", dir: lean }])!;
    expect(r.key).toBe("custom");
    expect(r.dir).toBe(lean);
    expect(r.length).toBeCloseTo(2, 12);
  });

  it("is nothing for a drag back onto the root", () => {
    expect(snapDrag([0, 0, 0], lookingDownY, axes)).toBeNull();
  });

  it("turns a drag into a load patch and a label", () => {
    // 100 px on screen at 0.5 mm per pixel, from an arrow pressed right at its tip.
    const start = forceDragStart(30, forceToArrowPx(30));
    const named = forceDragPatch({ key: "-Z", dir: [0, 0, -1], length: 50 }, 0.5, start);
    expect(named).toEqual({ direction: "-Z", custom: null, force: arrowPxToForce(100) });
    expect(forceDragLabel(named)).toBe(`${named.force} N, -z`);
    const free = forceDragPatch({ key: "custom", dir: [0.70710678, 0, -0.70710678], length: 20 }, 1, start);
    expect(free.custom).toEqual([0.707, 0, -0.707]);
    expect(forceDragLabel(free)).toBe(`${free.force} N`);
    expect(forceDragLabel({ direction: "into", force: 20 })).toBe("20 N, into the face");
  });
});

describe("where the glyphs stand", () => {
  const square: Tri[] = [
    [[0, 0, 0], [10, 0, 0], [10, 10, 0]],
    [[0, 0, 0], [10, 10, 0], [0, 10, 0]],
  ];

  it("puts a load's arrow at its faces' area centre", () => {
    const c = areaCentre(square)!;
    expect(c[0]).toBeCloseTo(5, 12);
    expect(c[1]).toBeCloseTo(5, 12);
    expect(c[2]).toBe(0);
    expect(areaCentre([])).toBeNull();
  });

  it("reads a face set as the engine gets it, saying what the view cannot show", () => {
    expect(faceCountLabel(faces(top, [0, 0, 1]))).toBe("1 face");
    expect(faceCountLabel({ ...faces(top, [0, 0, 1], 0, []) })).toBe("1 face (not shown in the view)");
    expect(faceCountLabel({ ...faces(top, [0, 0, 1], 0, []), missing: 1, unshown: 0 })).toBe("1 face, not found on the current model");
    const three = { selectors: [top, bottom, hole], faceIds: [1], normalSum: [0, 0, 1] as Vec3, area: 1 };
    expect(faceCountLabel({ ...three, missing: 1, unshown: 1 })).toBe("3 faces, 1 not found on the current model");
    expect(faceCountLabel({ ...three, missing: 0, unshown: 2 })).toBe("3 faces (2 not shown in the view)");
    expect(faceCountLabel({ selectors: [], faceIds: [], normalSum: [0, 0, 0], area: 0 })).toBe("none");
  });

  it("spreads pressure arrows over the faces, pointing in", () => {
    const tris: Tri[] = Array.from({ length: 40 }, (_, i) => [[i, 0, 0], [i + 1, 0, 0], [i, 1, 0]] as Tri);
    const sites = pressureSites(tris, tris.map(() => [0, 0, 1] as Vec3), 8);
    expect(sites).toHaveLength(8);
    expect(sites.every((s) => s.dir[2] === -1)).toBe(true);
    expect(sites[0]!.at[0]).toBeLessThan(sites[7]!.at[0]);
  });

  it("finds a pinned hole's axis from its tessellation, past both ends", () => {
    // A bore of radius 3 along Z from 0 to 10 through (1, 2).
    const points: Vec3[] = [];
    const normals: Vec3[] = [];
    const n = 24;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const b = (2 * Math.PI * (i + 1)) / n;
      const p = (t: number, z: number): Vec3 => [1 + 3 * Math.cos(t), 2 + 3 * Math.sin(t), z];
      points.push(p(a, 0), p(b, 0), p(a, 10), p(b, 0), p(b, 10), p(a, 10));
      const m = (a + b) / 2;
      normals.push([-Math.cos(m), -Math.sin(m), 0], [-Math.cos(m), -Math.sin(m), 0]);
    }
    const seg = pinAxisSegment(points, normals)!;
    expect(seg).not.toBeNull();
    for (const end of [seg.from, seg.to]) {
      expect(end[0]).toBeCloseTo(1, 6);
      expect(end[1]).toBeCloseTo(2, 6);
    }
    const lo = Math.min(seg.from[2], seg.to[2]);
    const hi = Math.max(seg.from[2], seg.to[2]);
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(10);
  });

  it("draws no axis for a flat face", () => {
    const pts: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 0, 0], [10, 10, 0], [0, 10, 0]];
    expect(pinAxisSegment(pts, [[0, 0, 1], [0, 0, 1]])).toBeNull();
  });
});

describe("the deformed shape", () => {
  // A 100 mm bar whose tip moves 2 mm down.
  const positions = [0, 0, 0, 100, 0, 0, 100, 10, 0];
  const displacement = [0, 0, 0, 0, 0, -2, 0, 0, -1];

  it("starts at the scale that draws the largest deflection at 5% of the body", () => {
    const size = Math.hypot(100, 10, 0);
    expect(autoDeformScale(positions, displacement)).toBe(roundSig((0.05 * size) / 2));
    expect(autoDeformScale(positions, [0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(1);
    expect(autoDeformScale([], [])).toBe(1);
  });

  it("keeps true scale on the slider and labels the factor", () => {
    expect(deformSliderMax(2.5)).toBe(10);
    expect(deformSliderMax(0.1)).toBe(1);
    expect(deformLabel(2.5)).toBe("2.5x");
    expect(deformLabel(1234)).toBe("1200x");
    expect(deformLabel(0)).toBe("0x");
  });

  it("moves each vertex by the scaled displacement", () => {
    expect([...displacedPositions(positions, displacement, 10)]).toEqual([0, 0, 0, 100, 0, -20, 100, 10, -10]);
    expect([...displacedPositions(positions, displacement, 0)]).toEqual(positions);
  });

  it("swings from none to the scale and back", () => {
    expect(swingScale(0, 8)).toBe(0);
    expect(swingScale(800, 8)).toBeCloseTo(8, 12);
    expect(swingScale(1600, 8)).toBeCloseTo(0, 12);
    expect(swingScale(400, 8)).toBeCloseTo(4, 12);
  });
});

describe("the probe", () => {
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [10, 0, 0];
  const c: Vec3 = [0, 10, 0];

  it("weights a point by its corners", () => {
    expect(barycentric(a, b, c, a)).toEqual([1, 0, 0]);
    const w = barycentric(a, b, c, [2.5, 5, 0]);
    expect(w[0]).toBeCloseTo(0.25, 12);
    expect(w[1]).toBeCloseTo(0.25, 12);
    expect(w[2]).toBeCloseTo(0.5, 12);
    // Off the plane counts as its projection; past an edge is pulled back onto it.
    const off = barycentric(a, b, c, [2.5, 5, 3]);
    expect(off[2]).toBeCloseTo(0.5, 12);
    const out = barycentric(a, b, c, [-1, 5, 0]);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
    expect(out[0] + out[1] + out[2]).toBeCloseTo(1, 12);
    expect(barycentric(a, a, a, a)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  const surface = {
    indices: [0, 1, 2],
    vonMises: [10, 20, 40],
    displacement: [0, 0, 0, 0, 0, -2, 0, 0, -4],
  };

  it("interpolates von Mises and the deflection vector across the triangle", () => {
    const v = probeValues(surface, 0, [0.25, 0.25, 0.5])!;
    expect(v.vonMises).toBeCloseTo(27.5, 12);
    expect(v.vector).toEqual([0, 0, -2.5]);
    expect(v.deflection).toBeCloseTo(2.5, 12);
    expect(probeValues(surface, 1, [1, 0, 0])).toBeNull();
    expect(probeValues({ indices: [0, 1, 2], vonMises: [1, 2, 3] }, 0, [0, 1, 0])).toEqual({ vonMises: 2, deflection: null, vector: null });
  });

  it("reads stress in MPa and deflection in the display unit", () => {
    expect(probeLabel({ vonMises: 27.5, deflection: 2.54 }, "mm")).toBe("27.5 MPa, 2.54 mm");
    setUnit("in");
    expect(probeLabel({ vonMises: 27.5, deflection: 2.54 }, "in")).toBe("27.5 MPa, 0.1 in");
    expect(probeLabel({ vonMises: 3, deflection: null }, "in")).toBe("3 MPa");
  });
});

describe("weight and reactions in the result", () => {
  const reply: StressReply = {
    body: "b1",
    name: "Hook",
    material: { name: "PLA", E: 3500, nu: 0.36, yield: 50, density: 1.24 },
    mesh: { nodes: 10, elements: 20, size: 2, minDihedral: 12 },
    maxVonMises: { value: 4, at: [0, 0, 0], face: 0 },
    maxDisplacement: { value: 0.01, at: [5, 5, 10], vector: [0, 0, -0.01] },
    safetyFactor: 12.5,
    applied: [0, 0, -100.5],
    reaction: [0, 0, 100.5],
    weight: [0, 0, -0.5],
    reactions: [[0, 0, 60], [0, 0, 40.5]],
  };

  it("shows the weight and each support's reaction, named by its kind", () => {
    const v = formatStressResult(reply, "mm", ["pinned", "slider"]);
    const row = (k: string) => v.rows.find((r) => r.k === k)?.v;
    expect(row("Weight")).toBe("0, 0, -0.5 N");
    expect(row("Support 1, pinned")).toBe("0, 0, 60 N");
    expect(row("Support 2, slider")).toBe("0, 0, 40.5 N");
  });

  it("leaves out a weight without gravity and a per-support row for one support", () => {
    const v = formatStressResult({ ...reply, weight: null, reactions: [[0, 0, 100.5]] }, "mm", ["fixed"]);
    expect(v.rows.some((r) => r.k === "Weight")).toBe(false);
    expect(v.rows.some((r) => r.k.startsWith("Support"))).toBe(false);
    expect(v.rows.find((r) => r.k === "Reaction")?.v).toBe("0, 0, 100.5 N");
  });
});

describe("an engine refusal in the panel", () => {
  it("names supports and loads the way the panel's rows do", () => {
    expect(panelMessage(
      "support 1 (supports[0]) is pinned, which needs cylindrical faces (a hole or a pin), but its face is flat, pick the round face of the hole or the pin",
    )).toBe(
      "Support 1 is pinned, which needs cylindrical faces (a hole or a pin), but its face is flat, pick the round face of the hole or the pin",
    );
    expect(panelMessage("support 2 (supports[1].faces[0]) matches no face of body1")).toBe("Support 2 matches no face of body1");
    expect(panelMessage("load 3 (loads[2]) has no faces")).toBe("Load 3 has no faces");
  });

  it("leaves other refusals alone but for the capital", () => {
    expect(panelMessage("the body can still slide along Z, add a support that holds it that way"))
      .toBe("The body can still slide along Z, add a support that holds it that way");
  });
});
