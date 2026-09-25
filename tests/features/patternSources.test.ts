// Which candidate features a features-mode pattern can repeat, and why the
// rest can't, mirroring the engine's own refusal so the tool can decide before
// ever reaching it.
import { describe, expect, it } from "vitest";
import { facesOwnedByFeatures, featureOwnersOfFaces, patternSources, spansBody } from "../../src/features/patternSources";
import type { Feature, RebuildResult } from "../../src/types";

const hole = (id: string): Feature =>
  ({ id, type: "hole", points: [] }) as unknown as Feature;

const extrude = (id: string, operation: "new" | "join" | "cut" | "intersect"): Feature =>
  ({ id, type: "extrude", sketch: "s1", distance: 5, operation }) as unknown as Feature;

const fillet = (id: string): Feature =>
  ({ id, type: "fillet", edges: [], radius: 2 }) as unknown as Feature;

const pressPull = (id: string, operation: "join" | "cut", mode?: string): Feature =>
  ({ id, type: "press-pull", face: [], distance: 3, operation, ...(mode ? { mode } : {}) }) as unknown as Feature;

const circularPattern = (id: string, features?: string[]): Feature =>
  ({ id, type: "patternCircular", count: 4, angle: 360, axis: "Z", ...(features ? { features } : {}) }) as unknown as Feature;

describe("patternSources", () => {
  it("takes a hole", () => {
    const doc = [hole("h1")];
    expect(patternSources(doc, ["h1"])).toEqual({ ids: ["h1"], refused: [] });
  });

  it("takes an extrude set to cut or join, not one that made a new body", () => {
    const doc = [extrude("e1", "join"), extrude("e2", "cut"), extrude("e3", "new"), extrude("e4", "intersect")];
    const { ids, refused } = patternSources(doc, ["e1", "e2", "e3", "e4"]);
    expect(ids).toEqual(["e1", "e2"]);
    expect(refused.map((r) => r.id)).toEqual(["e3", "e4"]);
    expect(refused[0]!.reason).toContain("no cut or join to repeat");
  });

  it("refuses a fillet by name, naming the type", () => {
    const doc = [{ ...fillet("f1"), name: "Round1" } as Feature];
    const { ids, refused } = patternSources(doc, ["f1"]);
    expect(ids).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toContain("Round1");
    expect(refused[0]!.reason).toContain("cannot be patterned");
  });

  it("falls back to the readable type label when a feature has no name", () => {
    const doc = [fillet("f1")];
    const { refused } = patternSources(doc, ["f1"]);
    expect(refused[0]!.reason).toContain("Fillet");
  });

  it("takes a press-pull that cut or joined", () => {
    const doc = [pressPull("p1", "join"), pressPull("p2", "cut")];
    expect(patternSources(doc, ["p1", "p2"]).ids).toEqual(["p1", "p2"]);
  });

  it("takes a press-pull left on auto, operation carries the truth", () => {
    const doc = [pressPull("p1", "join", "auto")];
    expect(patternSources(doc, ["p1"]).ids).toEqual(["p1"]);
  });

  it("refuses a press-pull whose mode overrode the operation to new or intersect", () => {
    const doc = [pressPull("p1", "join", "new"), pressPull("p2", "cut", "intersect")];
    const { ids, refused } = patternSources(doc, ["p1", "p2"]);
    expect(ids).toEqual([]);
    expect(refused).toHaveLength(2);
  });

  it("takes a pattern that itself lists features, not a body pattern", () => {
    const doc = [circularPattern("pc1", ["h1"]), circularPattern("pc2")];
    const { ids, refused } = patternSources(doc, ["pc1", "pc2"]);
    expect(ids).toEqual(["pc1"]);
    expect(refused.map((r) => r.id)).toEqual(["pc2"]);
  });

  it("returns patternable ids in timeline order, not candidate order", () => {
    const doc = [hole("h1"), hole("h2"), hole("h3")];
    expect(patternSources(doc, ["h3", "h1", "h2"]).ids).toEqual(["h1", "h2", "h3"]);
  });

  it("deduplicates a candidate id named twice", () => {
    const doc = [hole("h1")];
    expect(patternSources(doc, ["h1", "h1"]).ids).toEqual(["h1"]);
  });

  it("drops a candidate id the document no longer has", () => {
    const doc = [hole("h1")];
    const { ids, refused } = patternSources(doc, ["h1", "gone"]);
    expect(ids).toEqual(["h1"]);
    expect(refused).toEqual([]);
  });

  it("returns nothing for no candidates", () => {
    expect(patternSources([hole("h1")], [])).toEqual({ ids: [], refused: [] });
  });
});

const bodies = (): RebuildResult["bodies"] => [
  { id: "b1", name: "Body1", faceStart: 0, faceCount: 3, faceOwners: ["h1", "h1", null] },
  { id: "b2", name: "Body2", faceStart: 3, faceCount: 2, faceOwners: [null, "e1"] },
];

describe("featureOwnersOfFaces", () => {
  it("maps a face to the feature that owns it", () => {
    expect(featureOwnersOfFaces(bodies(), [0])).toEqual(["h1"]);
    expect(featureOwnersOfFaces(bodies(), [4])).toEqual(["e1"]);
  });

  it("drops a face with no owner", () => {
    expect(featureOwnersOfFaces(bodies(), [2, 3])).toEqual([]);
  });

  it("deduplicates, in the order the faces were given", () => {
    expect(featureOwnersOfFaces(bodies(), [1, 0, 4])).toEqual(["h1", "e1"]);
  });

  it("is empty with no bodies", () => {
    expect(featureOwnersOfFaces(undefined, [0])).toEqual([]);
  });
});

describe("spansBody", () => {
  const box = (a: number[], b: number[]) => ({
    min: { x: a[0]!, y: a[1]!, z: a[2]! },
    max: { x: b[0]!, y: b[1]!, z: b[2]! },
  });
  const body = box([-10, -10, -10], [10, 10, 10]);

  it("says the top a hole went through spans the body", () => {
    expect(spansBody(box([-10, -10, 10], [10, 10, 10]), body)).toBe(true);
  });

  it("keeps the hole's own wall", () => {
    expect(spansBody(box([-5, -5, -10], [-1.6, -1.6, 10]), body)).toBe(false);
  });

  it("keeps a pocket floor that reaches one side only", () => {
    expect(spansBody(box([-10, -2, 5], [10, 2, 5]), body)).toBe(false);
  });
});

describe("facesOwnedByFeatures", () => {
  it("gathers every face a feature owns, across bodies", () => {
    expect(facesOwnedByFeatures(bodies(), ["h1"])).toEqual([0, 1]);
    expect(facesOwnedByFeatures(bodies(), ["h1", "e1"])).toEqual([0, 1, 4]);
  });

  it("is empty for a feature that owns no face", () => {
    expect(facesOwnedByFeatures(bodies(), ["nope"])).toEqual([]);
  });

  it("is empty with no feature ids or no bodies", () => {
    expect(facesOwnedByFeatures(bodies(), [])).toEqual([]);
    expect(facesOwnedByFeatures(undefined, ["h1"])).toEqual([]);
  });
});
