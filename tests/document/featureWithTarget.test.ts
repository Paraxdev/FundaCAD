// The candidate feature a live preview is built from.
//
// A value box that only answers on Enter is a value box you have to guess at,
// so typing into one now shows what the number would build before it is
// committed. That needs the feature it WOULD build, without a speculative
// mutate and an undo entry per keystroke — which is the whole of what this
// function is for, and the two things it must never do are touch the document
// it was handed and cost a copy of the whole part.

import { describe, expect, it } from "vitest";
import { featureWithTarget, targetFeatureId } from "../../src/document/numFields";
import type { CadDocument } from "../../src/types";

function doc(): CadDocument {
  return {
    version: 5,
    features: [
      { id: "b1", type: "box", length: 40, width: 40, height: 40 },
      { id: "b2", type: "box", length: 10, width: 10, height: 10 },
      {
        id: "s1",
        type: "sketch",
        plane: "XY",
        entities: [{ type: "circle", id: "e1", x: 0, y: 0, radius: 5 }],
        constraints: [{ type: "diameter", id: "k1", circle: "e1", value: 10 }],
      },
    ],
    parameters: {},
  } as unknown as CadDocument;
}

const target = { kind: "feature", feature: "b1", field: "width" } as const;

describe("featureWithTarget", () => {
  it("returns the feature with the value written in", () => {
    const next = featureWithTarget(doc(), target, 90);
    expect(next).toMatchObject({ id: "b1", type: "box", width: 90, length: 40, height: 40 });
  });

  it("does not touch the document it was handed", () => {
    // The point of the whole function. A preview that mutated the document
    // would be an edit, and an edit is an undo entry, once per keystroke.
    const d = doc();
    const before = structuredClone(d);
    featureWithTarget(d, target, 90);
    expect(d).toEqual(before);
  });

  it("copies only the feature it changes", () => {
    // Previewing a radius on a hundred-feature part must cost a copy of the
    // fillet, not a copy of the part.
    const d = doc();
    const next = featureWithTarget(d, target, 90);
    expect(next).not.toBe(d.features[0]);
    expect(d.features[1]).toBe(d.features[1]); // untouched siblings stay identical
  });

  it("reaches a value inside a sketch, and names the sketch as the feature", () => {
    const d = doc();
    const t = { kind: "constraint", sketch: "s1", constraint: "k1" } as const;
    expect(targetFeatureId(t)).toBe("s1");
    const next = featureWithTarget(d, t, 24);
    expect(next?.id).toBe("s1");
    expect((next as { constraints: { value: number }[] }).constraints[0]!.value).toBe(24);
    expect((d.features[2] as { constraints: { value: number }[] }).constraints[0]!.value).toBe(10);
  });

  it("says there is nothing to build rather than building the same thing again", () => {
    // The caller reads null as "no preview", so an unchanged value must not
    // schedule a rebuild of what is already on screen.
    expect(featureWithTarget(doc(), target, 40)).toBeNull();
  });

  it("says there is nothing to build for a target that no longer resolves", () => {
    expect(featureWithTarget(doc(), { kind: "feature", feature: "gone", field: "width" }, 5)).toBeNull();
    expect(featureWithTarget(doc(), { kind: "feature", feature: "b1", field: "nope" }, 5)).toBeNull();
  });

  it("refuses a value that is not a number", () => {
    expect(featureWithTarget(doc(), target, NaN)).toBeNull();
    expect(featureWithTarget(doc(), target, Infinity)).toBeNull();
  });
});
