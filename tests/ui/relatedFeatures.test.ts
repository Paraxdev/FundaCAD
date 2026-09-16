import { describe, expect, it } from "vitest";
import { relatedFeatureIds, sketchesOf } from "../../src/ui/relatedFeatures";

const doc = [
  { id: "s1", type: "sketch" },
  { id: "e1", type: "extrude", sketch: "s1" },
  { id: "sh", type: "shell" },
  { id: "s2", type: "sketch" },
  { id: "e2", type: "extrude", sketch: "s2" },
  { id: "l1", type: "loft", profiles: [{ sketch: "s1", region: [0, 0, 0] }, { sketch: "s2", region: [0, 0, 5] }] },
];

describe("related features", () => {
  it("reads every way a feature names its sketch", () => {
    expect(sketchesOf({ sketch: "a" })).toEqual(["a"]);
    expect(sketchesOf({ sketches: ["a", "b"] })).toEqual(["a", "b"]);
    expect(sketchesOf(doc[5]!)).toEqual(["s1", "s2"]);
    expect(sketchesOf({ id: "x" })).toEqual([]);
  });

  it("a feature brings the sketch it was built from", () => {
    expect([...relatedFeatureIds(doc, ["e1", "sh"])].sort()).toEqual(["e1", "s1", "sh"]);
  });

  it("a sketch brings everything built from it", () => {
    expect([...relatedFeatureIds(doc, ["s2"])].sort()).toEqual(["e2", "l1", "s2"]);
  });

  it("ignores ids that are not in the document", () => {
    expect(relatedFeatureIds(doc, ["gone"]).size).toBe(0);
  });
});
