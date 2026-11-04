import { describe, expect, it, vi } from "vitest";
import { box, freshStore, opened } from "./storeKit";
import type { Feature } from "../../src/types";

vi.stubGlobal("window", globalThis);

const fillet = (id: string, radius: number) => ({ id, type: "fillet", radius }) as unknown as Feature;

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

  it("labels an edit and a rename", () => {
    const s = threeSteps();
    s.updateFeature("c", { radius: 3.25 } as Partial<Feature>);
    expect(s.undoLabel).toBe("Fillet 1");
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
