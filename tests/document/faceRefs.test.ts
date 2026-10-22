// Per face materials across a topology change, on real engine replies
// (tests/fixtures/faceRefs.json): body1 is a stepped block turned 25 deg about
// (30, 12), body2 a box at (95, -20) turned -10 deg that no scenario touches.
// Measured local faces of body1 in the base build: 0 -X end, 1 +Y side,
// 2 -Y upper, 3 upper top, 4 riser, 5 -Y lower, 6 bottom, 7 lower top, 8 +X end.
// After the fillet on the lower top / +Y edge OCCT orders them 0 +Y, 1 +X end,
// 2 FILLET, 3 bottom, 4 riser, 5 -X end, 6 upper top, 7 lower top, 8 -Y lower,
// 9 -Y upper.
import { describe, expect, it } from "vitest";
import { bodyPrints, resolveFaceRefs, type FaceRef, type FaceTrack } from "../../src/document/faceRefs";
import type { RebuildResult } from "../../src/types";
import { reply } from "./faceRefsFixture";

const span = (r: RebuildResult, id: string) => r.bodies!.find((b) => b.id === id)!;

/** Refs named by `name -> [body, face]`, printed on `on` unless `bare`. */
function refs(on: RebuildResult, faces: Record<string, [string, number]>, bare = false): [string, FaceRef][] {
  return Object.entries(faces).map(([id, [body, face]]) => {
    const ref: FaceRef = { body, face, material: "m-" + id };
    if (!bare) ref.at = bodyPrints(on, span(on, body))[face]!;
    return [id, ref];
  });
}

function trackOf(r: RebuildResult, list: [string, FaceRef][]): FaceTrack {
  return resolveFaceRefs(list, r, null).track;
}

const resolved = (list: [string, FaceRef][], r: RebuildResult, track: FaceTrack | null) =>
  Object.fromEntries(resolveFaceRefs(list, r, track).faces);

describe("resolveFaceRefs across a fillet", () => {
  const base = reply("base");
  const fillet = reply("fillet");

  it("three faces away from the filleted edge keep their material, the fillet face takes none", () => {
    const list = refs(base, { end: ["body1", 0], riser: ["body1", 4], lowerSide: ["body1", 5] });
    const want = { end: [5], riser: [4], lowerSide: [8] };
    expect(resolved(list, fillet, trackOf(base, list))).toEqual(want);
    expect(resolved(list, fillet, null)).toEqual(want);
  });

  it("every face of body1 follows the reordered list and body2 keeps its faces", () => {
    const named: Record<string, [string, number]> = {};
    for (let f = 0; f < 9; f++) named["b1f" + f] = ["body1", f];
    named["b2a"] = ["body2", 1];
    named["b2b"] = ["body2", 4];
    const list = refs(base, named);
    const want = { b1f0: [5], b1f1: [0], b1f2: [9], b1f3: [6], b1f4: [4], b1f5: [8], b1f6: [3], b1f7: [7], b1f8: [1], b2a: [1], b2b: [4] };
    expect(resolved(list, fillet, trackOf(base, list))).toEqual(want);
    expect(resolved(list, fillet, null)).toEqual(want);
  });

  it("undoing the fillet maps them back", () => {
    const list = refs(fillet, { end: ["body1", 5], top: ["body1", 7], side: ["body1", 0], round: ["body1", 2] });
    expect(resolved(list, base, trackOf(fillet, list))).toEqual({ end: [0], top: [7], side: [1], round: [] });
  });

  it("an assignment from an old document, with no print, keeps its index on the build it was saved against and follows from there", () => {
    const list = refs(base, { end: ["body1", 0], lowerTop: ["body1", 7], other: ["body2", 3] }, true);
    const first = resolveFaceRefs(list, base, null);
    expect(Object.fromEntries(first.faces)).toEqual({ end: [0], lowerTop: [7], other: [3] });
    expect(resolved(list, fillet, first.track)).toEqual({ end: [5], lowerTop: [7], other: [3] });
  });
});

describe("resolveFaceRefs when faces split, vanish or move", () => {
  const base = reply("base");

  it("a face a slot splits keeps its material on both parts, the slot floor takes none", () => {
    const list = refs(base, { lowerTop: ["body1", 7], plusY: ["body1", 1], lowerSide: ["body1", 5] });
    const want = { lowerTop: [6, 10], plusY: [1], lowerSide: [4] };
    expect(resolved(list, reply("slot"), trackOf(base, list))).toEqual(want);
    expect(resolved(list, reply("slot"), null)).toEqual(want);
  });

  it("faces a cut removes drop their material while the faces left keep theirs", () => {
    const list = refs(base, { upperTop: ["body1", 3], upperSide: ["body1", 2], riser: ["body1", 4], lowerTop: ["body1", 7], end: ["body1", 0] });
    const want = { upperTop: [], upperSide: [], riser: [], lowerTop: [4], end: [0] };
    expect(resolved(list, reply("unstep"), trackOf(base, list))).toEqual(want);
    expect(resolved(list, reply("unstep"), null)).toEqual(want);
  });

  it("faces a dimension edit moves follow through the previous build even as two of them merge", () => {
    const list = refs(base, { plusY: ["body1", 1], lowerSide: ["body1", 5], lowerTop: ["body1", 7], end: ["body1", 0] });
    expect(resolved(list, reply("deep"), trackOf(base, list))).toEqual({ plusY: [1], lowerSide: [2], lowerTop: [6], end: [0] });
  });

  it("a ref the build lost resumes from where it was last found, not from its first print", () => {
    const list = refs(base, { plusY: ["body1", 1], lowerSide: ["body1", 5] });
    const deep = reply("deep");
    const onDeep = resolveFaceRefs(list, deep, trackOf(base, list));
    const noBody1 = { ...deep, bodies: deep.bodies!.filter((b) => b.id !== "body1") };
    const lost = resolveFaceRefs(list, noBody1, onDeep.track);
    expect(Object.fromEntries(lost.faces)).toEqual({ plusY: [], lowerSide: [] });
    expect(resolved(list, reply("deep"), lost.track)).toEqual({ plusY: [1], lowerSide: [2] });
    expect(resolved(list, reply("deep"), null)).toEqual({ plusY: [], lowerSide: [] });
  });

  it("a body turned and moved with its face count unchanged keeps every index", () => {
    const [c, s] = [Math.cos(0.6), Math.sin(0.6)];
    const turn = (p: number[]) => p.map((_, i) => {
      const k = i - (i % 3), [x, y, z] = [p[k]! - 40, p[k + 1]! + 5, p[k + 2]! - 7];
      return [x * c - y * s + 53, x * s * 0.8 + y * c * 0.8 + z * 0.6 - 9, -x * s * 0.6 - y * c * 0.6 + z * 0.8 + 13][i % 3]!;
    });
    const named: Record<string, [string, number]> = {};
    for (let f = 0; f < 9; f++) named["f" + f] = ["body1", f];
    const list = refs(base, named);
    const want = Object.fromEntries(Object.keys(named).map((k, f) => [k, [f]]));
    expect(resolved(list, reply("base", turn), trackOf(base, list))).toEqual(want);
  });
});

describe("resolveFaceRefs on an unchanged build", () => {
  const base = reply("base");

  it("resolves no refs to nothing", () => {
    expect(resolved([], base, trackOf(base, []))).toEqual({});
  });

  it("keeps one ref and many refs where they are", () => {
    const one = refs(base, { only: ["body2", 5] });
    expect(resolved(one, base, trackOf(base, one))).toEqual({ only: [5] });
    const many = refs(base, { a: ["body1", 0], b: ["body1", 8], c: ["body2", 0], d: ["body2", 2] });
    expect(resolved(many, base, trackOf(base, many))).toEqual({ a: [0], b: [8], c: [0], d: [2] });
  });

  it("leaves a ref on a body the build no longer has, or a face past its end, on nothing", () => {
    const list = refs(base, { gone: ["body1", 0] }, true);
    list.push(["late", { body: "body2", face: 6, material: "m-late" }], ["lost", { body: "body9", face: 0, material: "m-lost" }]);
    expect(resolved(list, base, null)).toEqual({ gone: [0], late: [], lost: [] });
  });
});
