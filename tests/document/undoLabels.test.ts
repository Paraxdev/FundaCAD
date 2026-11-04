import { describe, expect, it, vi } from "vitest";
import { box, freshStore, opened } from "./storeKit";
import type { Feature } from "../../src/types";

vi.stubGlobal("window", globalThis);

const fillet = (id: string, radius: number) => ({ id, type: "fillet", radius }) as unknown as Feature;

const settle = () =>
  new Promise<void>((done) => {
    let i = 0;
    const tick = () => (++i > 10 ? done() : void setTimeout(tick, 0));
    tick();
  });

function threeSteps() {
  const s = freshStore();
  s.addFeature(box("a", 40.5, 22.25, 7));
  s.addFeature(box("b", 12.75, 9.5, 4.25));
  s.addFeature(fillet("c", 1.5));
  return s;
}

describe("undo labels on the store", () => {
  it("labels each step, and undo and redo return the label they moved", () => {
    const s = threeSteps();
    expect(s.undoLabel).toBe("Fillet 1");
    expect(s.redoLabel).toBeNull();
    expect(s.undo()).toBe("Fillet 1");
    expect(s.undoLabel).toBe("Box 2");
    expect(s.redoLabel).toBe("Fillet 1");
    expect(s.redo()).toBe("Fillet 1");
    expect(s.undoLabel).toBe("Fillet 1");
    expect(s.redoLabel).toBeNull();
  });

  it("returns null when there is nothing to step", () => {
    const s = freshStore();
    expect(s.undo()).toBeNull();
    expect(s.redo()).toBeNull();
    expect(s.undoLabel).toBeNull();
    expect(s.undoMark).toBeNull();
  });

  it("labels a slanted move and a delete", () => {
    const s = threeSteps();
    s.moveFeature("c", 0);
    expect(s.undoLabel).toBe("Move Fillet 1");
    s.removeFeature("b");
    expect(s.undoLabel).toBe("Delete Box 2");
    s.removeFeatures(["a", "c"]);
    expect(s.undoLabel).toBe("Delete 2 steps");
    expect(s.undo()).toBe("Delete 2 steps");
    expect(s.redoLabel).toBe("Delete 2 steps");
  });

  it("names the moved step when it swaps with its neighbour, up or down", () => {
    const two = freshStore();
    two.addFeature(box("a", 40.5, 22.25, 7));
    two.addFeature(fillet("c", 1.5));
    two.moveFeature("c", 0);
    const s = threeSteps();
    const labels: (string | null)[] = [];
    s.moveFeature("c", 1);
    labels.push(s.undoLabel);
    s.moveFeature("b", 1);
    labels.push(s.undoLabel);
    s.moveFeature("a", 1);
    labels.push(s.undoLabel);
    expect({ two: two.undoLabel, labels, order: s.document.features.map((f) => f.id), undone: s.undo() }).toEqual({
      two: "Move Fillet 1",
      labels: ["Move Fillet 1", "Move Box 2", "Move Box 1"],
      order: ["b", "a", "c"],
      undone: "Move Box 1",
    });
  });

  it("names a moved step as it was before the move, as a delete does", () => {
    const s = freshStore();
    for (const id of ["a", "b", "c"]) s.addFeature(box(id, 10, 10, 10));
    s.moveFeature("a", 2);
    const there = s.undoLabel;
    s.moveFeature("a", 0);
    expect([there, s.undoLabel, s.document.features.map((f) => f.id)]).toEqual([
      "Move Box 1",
      "Move Box 3",
      ["a", "b", "c"],
    ]);
  });

  it("a move of an id the document lacks is an unnamed edit", () => {
    const s = threeSteps();
    s.moveFeature("zz", 0);
    expect({ label: s.undoLabel, order: s.document.features.map((f) => f.id) }).toEqual({
      label: "Edit",
      order: ["a", "b", "c"],
    });
  });

  it("a parameter edit is named for the parameter, also when it drives a step", async () => {
    const s = opened({
      parameters: { r: 4.5, w: 3.25 },
      paramDefs: {
        r: { expr: "4.5", value: 4.5, unit: "mm", target: { kind: "feature", feature: "b", field: "length" } },
        w: { expr: "3.25", value: 3.25, unit: "mm" },
      },
      features: [box("a", 40.5, 22.25, 7), box("b", 4.5, 9.5, 4.25)],
    });
    const lengthOfB = () => (s.document.features[1] as unknown as { length: number }).length;
    expect(s.setParamExpr("r", "6.25")).toBeNull();
    await settle();
    const driven = { label: s.undoLabel, length: lengthOfB() };
    expect(s.setParamExpr("w", "2.75")).toBeNull();
    await settle();
    expect({ driven, plain: s.undoLabel, length: lengthOfB() }).toEqual({
      driven: { label: "Parameter r", length: 6.25 },
      plain: "Parameter w",
      length: 6.25,
    });
  });

  it("labels an edit and a rename", () => {
    const s = threeSteps();
    s.updateFeature("c", { radius: 3.25 } as Partial<Feature>);
    expect(s.undoLabel).toBe("edit of Fillet 1");
    expect([s.undo(), s.redo()]).toEqual(["edit of Fillet 1", "edit of Fillet 1"]);
    s.renameFeature("c", "Round");
    expect(s.undoLabel).toBe("Rename Fillet 1");
  });

  it("labels a suppress with the name, many as a count, and an overlay step by its kind", () => {
    const s = threeSteps();
    s.toggleSuppress("b");
    expect(s.undoLabel).toBe("Suppress Box 2");
    s.toggleSuppress("b");
    expect(s.undoLabel).toBe("Unsuppress Box 2");
    s.setSuppressed(["a", "b", "c"], true);
    expect(s.undoLabel).toBe("Suppress 3 steps");
    s.setBodyVisibility("body1", false);
    expect(s.undoLabel).toBe("Body visibility");
    s.setBodyName("body2", "Lid");
    expect(s.undoLabel).toBe("Rename body");
    s.setSketchVisibility("a", false);
    expect(s.undoLabel).toBe("Hide Box 1");
    expect(s.undo()).toBe("Hide Box 1");
    expect(s.undo()).toBe("Rename body");
  });

  it("a group takes its first entry's label, an explicit label wins", () => {
    const s = threeSteps();
    s.undoAsOne(() => {
      s.setBodyName("body1", "Base");
      s.setBodyVisibility("body2", false);
    });
    expect(s.undoLabel).toBe("Rename body");
    expect(s.undo()).toBe("Rename body");
    expect(s.redoLabel).toBe("Rename body");
    s.undoAsOne(() => s.setBodyVisibility("body2", false), undefined, { label: "Hide the lid" });
    expect(s.undoLabel).toBe("Hide the lid");
  });

  it("a join keeps the label and the mark of the step it joined", () => {
    const s = threeSteps();
    const mark = s.undoMark;
    s.undoAsOne(
      () => s.setBodyName("body1", "Base"),
      (before) => before.features.length === 2,
    );
    expect(s.undoLabel).toBe("Fillet 1");
    expect(s.undoMark).toBe(mark);
  });

  it("the 51st step drops the oldest and the labels stay right", () => {
    const s = freshStore();
    for (let i = 0; i < 51; i++) s.addFeature(box(`b${i}`, 10.5 + i));
    const seen: (string | null)[] = [];
    for (let i = 0; i < 60; i++) seen.push(s.undo());
    expect(seen.filter((l) => l !== null)).toHaveLength(50);
    expect(seen[0]).toBe("Box 51");
    expect(seen[49]).toBe("Box 2");
    expect(seen[50]).toBeNull();
  });

  it("marks differ per entry and survive undo and redo", () => {
    const s = threeSteps();
    const top = s.undoMark!;
    s.undo();
    const below = s.undoMark!;
    expect(below).not.toBe(top);
    s.redo();
    expect(s.undoMark).toBe(top);
    expect(s.undoIfMark(below)).toBeNull();
    expect(s.canRedo).toBe(false);
    expect(s.undoIfMark(top)).toBe("Fillet 1");
    expect(s.undoMark).toBe(below);
  });

  it("a version restore is labelled, and a second document leaks nothing", () => {
    const s = opened({ features: [box("a", 10.5)] });
    const v = s.saveVersion("one")!;
    s.addFeature(box("b", 4.25, 2));
    s.restoreVersion(v.id);
    expect(s.undoLabel).toBe("Restore version");
    const mark = s.undoMark!;
    s.newDocument();
    expect(s.undoLabel).toBeNull();
    expect(s.redoLabel).toBeNull();
    expect(s.undoIfMark(mark)).toBeNull();
    s.load(JSON.stringify({ parameters: {}, features: [box("z", 8.5)] }));
    expect(s.undoLabel).toBeNull();
    expect(s.undoMark).toBeNull();
    s.addFeature(box("y", 3.5));
    expect(s.undoMark).not.toBe(mark);
    expect(s.undoIfMark(mark)).toBeNull();
    expect(s.document.features.map((f) => f.id)).toEqual(["z", "y"]);
  });

  it("a replacing load is labelled by what it changed", () => {
    const s = threeSteps();
    s.load(JSON.stringify({ parameters: {}, features: [box("a", 40.5, 22.25, 7), fillet("c", 1.5)] }), {
      replace: true,
    });
    expect(s.undoLabel).toBe("Delete Box 2");
    s.load(JSON.stringify({ parameters: {}, features: s.document.features }), { replace: true });
    expect(s.undoLabel).toBe("Edit");
  });
});
