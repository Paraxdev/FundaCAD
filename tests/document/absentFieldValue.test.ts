// A fillet's profile is left out at 0, the plain Round, as the Fillet tool writes it: the properties row reads 0 and
// committing 0 keeps the field out of the document.

import { describe, expect, it } from "vitest";
import { absentFieldValue, featureWithTarget, writeTarget } from "../../src/document/numFields";
import type { CadDocument } from "../../src/types";

function doc(profile?: number): CadDocument {
  const fillet: Record<string, unknown> = { id: "f1", type: "fillet", radius: 2, edges: [] };
  if (profile !== undefined) fillet.profile = profile;
  return {
    version: 10,
    features: [{ id: "b1", type: "box", length: 20, width: 20, height: 20 }, fillet],
    parameters: {},
  } as unknown as CadDocument;
}

const target = { kind: "feature", feature: "f1", field: "profile" } as const;

describe("a field left out at its default", () => {
  it("reads 0 for a fillet's profile and nothing for other fields", () => {
    expect(absentFieldValue("fillet", "profile")).toBe(0);
    expect(absentFieldValue("fillet", "radius")).toBeUndefined();
    expect(absentFieldValue("chamfer", "profile")).toBeUndefined();
  });

  it("writes nothing when 0 is committed to a fillet without a profile", () => {
    const d = doc();
    const before = d.features[1];
    expect(writeTarget(d, target, 0)).toBeNull();
    expect(d.features[1]).toBe(before);
    expect("profile" in d.features[1]!).toBe(false);
    expect(featureWithTarget(doc(), target, 0)).toBeNull();
  });

  it("drops the field when a profile goes back to 0", () => {
    const d = doc(0.5);
    expect(writeTarget(d, target, 0)).toEqual({});
    expect("profile" in d.features[1]!).toBe(false);
  });

  it("still writes a profile off 0", () => {
    const d = doc();
    expect(writeTarget(d, target, 0.5)).toEqual({});
    expect((d.features[1] as { profile?: number }).profile).toBe(0.5);
  });
});
