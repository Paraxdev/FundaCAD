import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { buildMenubar } from "../../src/app/menubarDef";
import { usePanelsStore } from "../../src/stores/panels";
import type { Engine } from "../../src/app/engine";
import { box, freshStore } from "../document/storeKit";
import { menuName } from "../../src/ui/menu";

describe("Undo and Redo in the Edit menu", () => {
  beforeEach(() => setActivePinia(createPinia()));

  const offFor = (e: unknown) => {
    const edit = buildMenubar(e as Engine).find((m) => menuName(m) === "Edit")!;
    const item = (name: string) => edit.items.find((i) => i.refName === name)!;
    return () => [item("Undo").disabled?.(), item("Redo").disabled?.()];
  };

  const labelsFor = (e: unknown) => {
    const edit = buildMenubar(e as Engine).find((m) => menuName(m) === "Edit")!;
    const text = (name: string) => {
      const l = edit.items.find((i) => i.refName === name)!.label;
      return typeof l === "function" ? l() : l;
    };
    return () => [text("Undo"), text("Redo")];
  };

  it("name the step they would take, read again on every open", () => {
    const store = freshStore();
    const labels = labelsFor({ sketch: { active: false }, store });
    expect(labels()).toEqual(["Undo", "Redo"]);
    store.addFeature(box("a", 40.5, 22.25, 7));
    store.addFeature(box("b", 12.75, 9.5, 4.25));
    expect(labels()).toEqual(["Undo Box 2", "Redo"]);
    store.undo();
    expect(labels()).toEqual(["Undo Box 1", "Redo Box 2"]);
    store.undo();
    expect(labels()).toEqual(["Undo", "Redo Box 1"]);
  });

  it("name the Stress step while its panel is open and a sketch edit while a sketch is", () => {
    const store = freshStore();
    store.addFeature(box("a", 40.5, 22.25, 7));
    const sketch = { active: false, canUndoSketch: true, canRedoSketch: false };
    const labels = labelsFor({ sketch, store });
    const panels = usePanelsStore();
    panels.showStress("body1");
    panels.stress!.undoLabel = "Add support";
    panels.stress!.redoLabel = "Load 2 force";
    expect(labels()).toEqual(["Undo Add support", "Redo Load 2 force"]);
    sketch.active = true;
    expect(labels()).toEqual(["Undo sketch edit", "Redo"]);
    sketch.active = false;
    panels.stress = null;
    expect(labels()).toEqual(["Undo Box 1", "Redo"]);
  });

  it("follow the Stress setup while the panel is open, and the model once it closes", () => {
    const off = offFor({ sketch: { active: false }, store: { canUndo: true, canRedo: false } });
    const panels = usePanelsStore();
    panels.showStress("body1");
    expect(off()).toEqual([true, true]);
    panels.stress!.canRedo = true;
    expect(off()).toEqual([true, false]);
    panels.stress = null;
    expect(off()).toEqual([false, true]);
  });

  it("follow an open sketch before Stress", () => {
    const sketch = { active: true, canUndoSketch: true, canRedoSketch: false };
    const off = offFor({ sketch, store: { canUndo: false, canRedo: true } });
    usePanelsStore().showStress("body1");
    expect(off()).toEqual([false, true]);
  });
});
