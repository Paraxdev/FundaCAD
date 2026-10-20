import { describe, expect, it } from "vitest";
import { thinExtrudeOf } from "../../src/features/thinExtrude";
import { choiceFieldsFor, fieldApplies, toggleFieldsFor } from "../../src/document/optionFields";
import { featureMeta } from "../../src/ui/featureMeta";
import type { Feature } from "../../src/types";

const plane = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] } as never;

function doc(entities: unknown[]): Feature[] {
  return [{ id: "sk", type: "sketch", plane, entities } as Feature];
}

describe("thin extrude of an open sketch", () => {
  it("builds a wall along every curve of the sketch", () => {
    const f = thinExtrudeOf(doc([
      { type: "line", id: "a", x1: 0, y1: 0, x2: 40, y2: 0 },
      { type: "line", id: "b", x1: 40, y1: 0, x2: 40, y2: 30 },
      { type: "line", id: "c", x1: 0, y1: 10, x2: 40, y2: 10, construction: true },
      { type: "point", id: "p", x: 1, y: 1 },
      { type: "spline", id: "s", points: [{ x: 0, y: 0 }, { x: 1, y: 2 }] },
    ]), "sk", "ex");
    expect(f).toEqual({
      id: "ex", type: "extrude", sketch: "sk", distance: 10, operation: "new",
      thin: true, curves: ["a", "b"], thickness: 2, side: "center",
    });
  });

  it("gives nothing for a sketch with no curve a wall can follow", () => {
    expect(thinExtrudeOf(doc([{ type: "point", id: "p", x: 0, y: 0 }]), "sk", "ex")).toBeNull();
    expect(thinExtrudeOf(doc([]), "missing", "ex")).toBeNull();
  });
});

describe("thin extrude option rows", () => {
  it("offers a Thin switch and a wall side", () => {
    expect(toggleFieldsFor("extrude").map((t) => t.field)).toContain("thin");
    expect(choiceFieldsFor("extrude").map((c) => c.field)).toContain("side");
  });

  it("shows thickness and side only on a thin extrude, thickness 2 only for two sides", () => {
    expect(fieldApplies("extrude", "thickness", {})).toBe(false);
    expect(fieldApplies("extrude", "side", {})).toBe(false);
    expect(fieldApplies("extrude", "thickness", { thin: true })).toBe(true);
    expect(fieldApplies("extrude", "side", { thin: true })).toBe(true);
    expect(fieldApplies("extrude", "thickness2", { thin: true, side: "inside" })).toBe(false);
    expect(fieldApplies("extrude", "thickness2", { thin: true, side: "twoSides" })).toBe(true);
    expect(fieldApplies("extrude", "thickness2", { side: "twoSides" })).toBe(false);
  });

  it("names the history chip Thin extrude", () => {
    expect(featureMeta({ type: "extrude", thin: true }).label).toBe("Thin extrude");
    expect(featureMeta({ type: "extrude" }).label).toBe("Extrude");
  });
});
