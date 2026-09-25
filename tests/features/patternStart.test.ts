// What Pattern does with what it is pointed at: a feature the user selected
// that cannot be patterned is refused, never swapped for a whole body pattern.
import { describe, expect, it } from "vitest";
import { patternStart } from "../../src/features/patternSources";
import type { Feature, RebuildResult } from "../../src/types";

const f = (o: Record<string, unknown>): Feature => o as unknown as Feature;
const doc: Feature[] = [
  f({ id: "sk", type: "sketch", plane: "XY", entities: [] }),
  f({ id: "ex", type: "extrude", sketch: "sk", distance: 10, operation: "new" }),
  f({ id: "fil", type: "fillet", edges: [], radius: 2, name: "Round1" }),
  f({ id: "vef", type: "verticalEdgeFillet", radius: 2 }),
  f({ id: "h", type: "hole", points: [] }),
  f({ id: "bx", type: "box", length: 5, width: 5, height: 5 }),
];
const bodies: RebuildResult["bodies"] = [
  { id: "body1", name: "Body1", faceStart: 0, faceCount: 3, faceOwners: ["ex", "fil", "h"] },
  { id: "body2", name: "Body2", faceStart: 3, faceCount: 1, faceOwners: ["bx"] },
];
const at = (ids: string[], picked = false, explicit = true) => ({ ids, picked, explicit });

describe("patternStart", () => {
  it("repeats a patternable feature", () => {
    expect(patternStart(doc, at(["h"]), bodies)).toEqual({ mode: "features", ids: ["h"] });
  });

  it("refuses a fillet selected in the history, naming it and what can be patterned", () => {
    const r = patternStart(doc, at(["fil"]), bodies);
    expect(r.mode).toBe("refuse");
    if (r.mode !== "refuse") return;
    expect(r.reason).toContain("Round1");
    expect(r.reason).toContain("cannot be patterned");
    expect(r.reason).toContain("a hole");
  });

  it("refuses a plugin feature it knows nothing about rather than patterning the body", () => {
    expect(patternStart(doc, at(["vef"]), bodies).mode).toBe("refuse");
  });

  it("refuses a feature whose face was clicked", () => {
    expect(patternStart(doc, at(["fil"], true), bodies).mode).toBe("refuse");
  });

  it("patterns the body a selected body-making feature made", () => {
    expect(patternStart(doc, at(["ex"]), bodies)).toEqual({ mode: "body", body: "body1" });
    expect(patternStart(doc, at(["bx"]), bodies)).toEqual({ mode: "body", body: "body2" });
  });

  it("falls back to the body pattern for a selection the app made on its own", () => {
    expect(patternStart(doc, at(["sk"], false, false), bodies)).toEqual({ mode: "body", body: null });
    expect(patternStart(doc, at(["sk"]), bodies).mode).toBe("refuse");
  });

  it("with nothing pointed at is a body pattern", () => {
    expect(patternStart(doc, at([]), bodies)).toEqual({ mode: "body", body: null });
  });
});
