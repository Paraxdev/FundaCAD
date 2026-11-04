import { describe, expect, it } from "vitest";
import { deletedWhat, stepLabel } from "../../src/document/stepLabels";
import type { CadDocument, Feature } from "../../src/types";

const f = (id: string, type: string, extra: object = {}) => ({ id, type, ...extra }) as unknown as Feature;
const doc = (features: Feature[], parameters: Record<string, number> = {}): CadDocument =>
  ({ parameters, features }) as unknown as CadDocument;
const copy = (d: CadDocument): CadDocument => structuredClone(d);

const box = f("a", "box", { w: 40.5, d: 22.25, h: 7 });
const fillet1 = f("b", "fillet", { radius: 1.5 });
const extrude = f("c", "extrude", { distance: 12.75 });
const fillet2 = f("d", "fillet", { radius: 2.25 });
const base = doc([box, fillet1, extrude, fillet2]);

describe("deletedWhat", () => {
  it("names one step, counts several, and counts none as zero", () => {
    expect(deletedWhat(base.features, ["c"])).toBe("Extrude 1");
    expect(deletedWhat(base.features, ["d"])).toBe("Fillet 2");
    expect(deletedWhat(base.features, ["b", "d", "c"])).toBe("3 steps");
    expect(deletedWhat(base.features, ["b", "d"])).toBe("2 steps");
    expect(deletedWhat(base.features, ["zz"])).toBe("0 steps");
  });
});

describe("stepLabel", () => {
  it("names one added step by its place after the step", () => {
    const after = doc([...base.features, f("e", "fillet", { radius: 0.5 })]);
    expect(stepLabel(base, after)).toBe("Fillet 3");
  });

  it("counts several added steps", () => {
    const after = doc([...base.features, f("e", "fillet"), f("g", "chamfer")]);
    expect(stepLabel(base, after)).toBe("Add 2 steps");
  });

  it("names one deleted step from the document before, several as a count", () => {
    expect(stepLabel(base, doc([box, fillet1, fillet2]))).toBe("Delete Extrude 1");
    expect(stepLabel(base, doc([box, fillet2]))).toBe("Delete 2 steps");
    expect(stepLabel(base, doc([box]))).toBe("Delete 3 steps");
  });

  it("names a delete over an add when a step is replaced", () => {
    expect(stepLabel(base, doc([box, fillet1, f("z", "chamfer"), fillet2]))).toBe("Delete Extrude 1");
  });

  it("names a step that only moved by its name before the step, as a delete does", () => {
    expect(stepLabel(base, doc([box, fillet2, fillet1, extrude]))).toBe("Move Fillet 2");
    expect(stepLabel(base, doc([fillet1, box, extrude, fillet2]))).toBe("Move Box 1");
    expect(stepLabel(base, doc([extrude, fillet2, box, fillet1]))).toBe("Move 4 steps");
    const boxes = doc([box, f("e", "box"), f("g", "box")]);
    expect(stepLabel(boxes, doc([f("e", "box"), f("g", "box"), box]))).toBe("Move Box 1");
  });

  it("names one edited step, several as a count", () => {
    const one = copy(base);
    (one.features[3] as unknown as { radius: number }).radius = 3.75;
    expect(stepLabel(base, one)).toBe("Fillet 2");
    (one.features[0] as unknown as { w: number }).w = 41;
    expect(stepLabel(base, one)).toBe("Edit 2 steps");
  });

  it("tells a rename from an edit and uses the name before for a rename", () => {
    const renamed = copy(base);
    (renamed.features[3] as unknown as { name: string }).name = "Round";
    expect(stepLabel(base, renamed)).toBe("Rename Fillet 2");
    (renamed.features[3] as unknown as { radius: number }).radius = 9;
    expect(stepLabel(base, renamed)).toBe("Round");
  });

  it("names the one parameter that changed, several as Parameters", () => {
    const a = doc(base.features, { width: 40.5, depth: 12 });
    const b = copy(a);
    b.parameters["width"] = 44.25;
    expect(stepLabel(a, b)).toBe("Parameter width");
    b.parameters["depth"] = 13;
    expect(stepLabel(a, b)).toBe("Parameters");
    const c = copy(a);
    c.parameters["height"] = 3;
    expect(stepLabel(a, c)).toBe("Parameter height");
  });

  it("reads paramDefs ahead of the plain values", () => {
    const a = { ...doc(base.features, { width: 5 }), paramDefs: { width: { value: 5 } } } as unknown as CadDocument;
    const b = copy(a);
    (b as unknown as { paramDefs: Record<string, { value: number }> }).paramDefs.width!.value = 6.5;
    expect(stepLabel(a, b)).toBe("Parameter width");
  });

  it("falls back to Edit when the diff finds nothing it can name", () => {
    expect(stepLabel(base, copy(base))).toBe("Edit");
  });

  it("puts a feature change ahead of a parameter change", () => {
    const a = doc(base.features, { width: 1 });
    const b = copy(a);
    b.parameters["width"] = 2;
    (b.features[1] as unknown as { radius: number }).radius = 8;
    expect(stepLabel(a, b)).toBe("Fillet 1");
  });
});
